/**
 * AppClaw CLI — Agentic AI layer for mobile automation via appium-mcp.
 *
 * Usage:
 *   npx tsx src/index.ts                          # interactive mode
 *   npx tsx src/index.ts "Open Settings"           # run goal directly
 *   npx tsx src/index.ts --record "Open Settings"  # run + record for replay
 *   npx tsx src/index.ts --replay <file>           # replay a recording
 *   npx tsx src/index.ts --flow <file.yaml>        # run declarative YAML steps (no LLM)
 *   npx tsx src/index.ts --plan "complex goal"     # decompose + run sub-goals
 */

import { loadConfig } from "./config.js";
import { createMCPClient } from "./mcp/client.js";
import { extractText } from "./mcp/tools.js";
import { androidCreateSessionArgs } from "./mcp/session-caps.js";
import { setDeviceScreenSize } from "./vision/window-size.js";
import { createLLMProvider, buildModel, buildThinkingOptions } from "./llm/provider.js";
import { getScreenState } from "./perception/screen.js";
import { AppResolver } from "./agent/app-resolver.js";
import { runAgent } from "./agent/loop.js";
import { SessionLogger } from "./logger.js";
import { ActionRecorder } from "./recording/recorder.js";
import { loadRecording, replayRecording } from "./recording/replayer.js";
import { parseFlowYamlFile } from "./flow/parse-yaml-flow.js";
import { runYamlFlow } from "./flow/run-yaml-flow.js";
import { decomposeGoal, createPlanExecutor, evaluateSubGoal, evaluateScreen, assessScreenReadiness } from "./agent/planner.js";
import { DEFAULT_MODELS } from "./constants.js";
import { getStarkVisionModel } from "./vision/locate-enabled.js";
import { prepareScreenshotForLlm } from "./vision/prepare-screenshot-for-llm.js";
import { runExplorer } from "./explorer/index.js";
import type { ExplorerConfig } from "./explorer/types.js";
import { runPlayground } from "./playground/index.js";
import * as ui from "./ui/terminal.js";

interface CLIArgs {
  goal: string;
  record: boolean;
  replay: string | null;
  flow: string | null;
  playground: boolean;
  plan: boolean;
  explore: string | null;
  numFlows: number;
  noCrawl: boolean;
  outputDir: string;
  maxScreens: number;
  maxDepth: number;
}

function printHelp(): void {
  console.log(`
  Usage: appclaw [options] [goal]

  Options:
    --help              Show this help message
    --version           Show version number
    --flow <file.yaml>  Run declarative YAML steps (no LLM needed)
    --playground        Interactive REPL to build YAML flows step-by-step
    --explore <prd>     Explore mode: generate test flows from a PRD
    --num-flows <N>     Number of flows to generate (default: 5)
    --no-crawl          Skip device crawling (PRD-only flow generation)
    --output-dir <dir>  Output directory for generated flows (default: generated-flows)
    --max-screens <N>   Max screens to crawl (default: 10)
    --max-depth <N>     Max navigation depth for crawling (default: 3)

  Examples:
    appclaw "Open Settings"
    appclaw "Send hello on WhatsApp to Mom"
    appclaw "Turn on WiFi"
    appclaw --flow examples/flows/google-search.yaml
    appclaw --playground
    appclaw --explore "YouTube app that plays videos and lets users search"
    appclaw --explore prd.txt --num-flows 10 --no-crawl
    appclaw --explore "Settings app with WiFi, Bluetooth, Display" --num-flows 3
`);
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log("0.1.0");
    process.exit(0);
  }

  let record = false;
  let replay: string | null = null;
  let flow: string | null = null;
  let playground = false;
  let plan = false;
  let explore: string | null = null;
  let numFlows = 5;
  let noCrawl = false;
  let outputDir = "generated-flows";
  let maxScreens = 10;
  let maxDepth = 3;
  const goalParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--record") {
      record = true;
    } else if (args[i] === "--replay") {
      replay = args[++i] ?? null;
    } else if (args[i] === "--flow") {
      flow = args[++i] ?? null;
    } else if (args[i] === "--playground") {
      playground = true;
    } else if (args[i] === "--plan") {
      plan = true;
    } else if (args[i] === "--explore") {
      explore = args[++i] ?? null;
    } else if (args[i] === "--num-flows") {
      numFlows = parseInt(args[++i] ?? "5", 10) || 5;
    } else if (args[i] === "--no-crawl") {
      noCrawl = true;
    } else if (args[i] === "--output-dir") {
      outputDir = args[++i] ?? "generated-flows";
    } else if (args[i] === "--max-screens") {
      maxScreens = parseInt(args[++i] ?? "10", 10) || 10;
    } else if (args[i] === "--max-depth") {
      maxDepth = parseInt(args[++i] ?? "3", 10) || 3;
    } else {
      goalParts.push(args[i]);
    }
  }

  return { goal: goalParts.join(" ").trim(), record, replay, flow, playground, plan, explore, numFlows, noCrawl, outputDir, maxScreens, maxDepth };
}

async function main() {
  const config = loadConfig();
  const cliArgs = parseArgs();

  // ─── Replay mode ──────────────────────────────────────
  if (cliArgs.replay) {
    ui.printHeader();
    ui.printReplayHeader(cliArgs.replay);
    const recording = loadRecording(cliArgs.replay);

    const mcpClient = await createMCPClient({
      transport: config.MCP_TRANSPORT,
      host: config.MCP_HOST,
      port: config.MCP_PORT,
    });
    const mcp = mcpClient;

    try {
      const result = await replayRecording(mcpClient, recording, {
        adaptive: true,
        stepDelay: config.STEP_DELAY,
        maxElements: config.MAX_ELEMENTS,
      });
      process.exit(result.success ? 0 : 1);
    } finally {
      await mcpClient.close();
    }
    return;
  }

  // ─── Playground mode (interactive REPL → YAML) ───────────
  if (cliArgs.playground) {
    await runPlayground();
    return;
  }

  // ─── Explorer mode (PRD → flows) ─────────────────────────
  if (cliArgs.explore) {
    // Validate LLM API key
    if (config.LLM_PROVIDER !== "ollama" && !config.LLM_API_KEY) {
      ui.printError(
        `LLM_API_KEY is required for provider "${config.LLM_PROVIDER}".`,
        `Set it in .env or as an environment variable.`
      );
      process.exit(1);
    }

    ui.printHeader();
    ui.printExplorerHeader();

    const explorerConfig: ExplorerConfig = {
      prd: cliArgs.explore,
      numFlows: cliArgs.numFlows,
      outputDir: cliArgs.outputDir,
      crawl: !cliArgs.noCrawl,
      maxScreens: cliArgs.maxScreens,
      maxDepth: cliArgs.maxDepth,
    };

    // If crawling is enabled, connect to device
    let mcp: Awaited<ReturnType<typeof createMCPClient>> | undefined;
    if (explorerConfig.crawl) {
      try {
        ui.startSpinner(`Connecting to appium-mcp (${config.MCP_TRANSPORT})...`);
        mcp = await createMCPClient({
          transport: config.MCP_TRANSPORT,
          host: config.MCP_HOST,
          port: config.MCP_PORT,
        });
        ui.stopSpinner();
        ui.printSetupOk("Connected to appium-mcp");

        // Create Appium session
        ui.startSpinner("Creating Appium session...");
        const sessionResult = await mcp.callTool("create_session", androidCreateSessionArgs(config));
        const resultText = extractText(sessionResult);
        if (resultText.toLowerCase().includes("error") || resultText.toLowerCase().includes("failed")) {
          throw new Error(resultText);
        }
        ui.stopSpinner();
        ui.printSetupOk("Appium session created");
      } catch (err: any) {
        ui.stopSpinner();
        ui.printWarning(`Device connection failed: ${err?.message ?? err}. Continuing without crawling.`);
        explorerConfig.crawl = false;
        if (mcp) {
          await mcp.close();
          mcp = undefined;
        }
      }
    }

    try {
      const result = await runExplorer(explorerConfig, config, mcp);
      process.exit(result.success ? 0 : 1);
    } finally {
      if (mcp) await mcp.close();
    }
    return;
  }

  // ─── YAML flow mode (no LLM) ───────────────────────────
  if (cliArgs.flow) {
    ui.printHeader();
    ui.printYamlFlowHeader(cliArgs.flow);

    const mcpClient = await createMCPClient({
      transport: config.MCP_TRANSPORT,
      host: config.MCP_HOST,
      port: config.MCP_PORT,
    });
    const mcp = mcpClient;

    try {
      let parsed;
      try {
        parsed = parseFlowYamlFile(cliArgs.flow);
      } catch (err) {
        ui.printError("Invalid flow YAML", String(err));
        process.exit(1);
      }

      ui.startSpinner("Creating Appium session…");
      try {
        const sessionResult = await mcp.callTool("create_session", androidCreateSessionArgs(config));
        const resultText = extractText(sessionResult);
        if (resultText.toLowerCase().includes("error") || resultText.toLowerCase().includes("failed")) {
          throw new Error(resultText);
        }
        ui.stopSpinner();
        ui.printSetupOk("Appium session created");
      } catch (err: unknown) {
        ui.stopSpinner();
        const msg = err instanceof Error ? err.message : String(err);
        ui.printSetupError(`Failed to create Appium session: ${msg}`, "Connect a device/emulator: adb devices");
        process.exit(1);
      }

      const flowAppResolver = new AppResolver();
      await flowAppResolver.initialize(mcp);

      const result = await runYamlFlow(mcp, parsed.meta, parsed.steps, {
        stepDelayMs: config.STEP_DELAY,
        appResolver: flowAppResolver,
      });
      process.exit(result.success ? 0 : 1);
    } finally {
      await mcpClient.close();
    }
    return;
  }

  // ─── Normal / Record / Plan mode ──────────────────────

  // Validate LLM API key
  if (config.LLM_PROVIDER !== "ollama" && !config.LLM_API_KEY) {
    ui.printError(
      `LLM_API_KEY is required for provider "${config.LLM_PROVIDER}".`,
      `Set it in .env or as an environment variable.`
    );
    process.exit(1);
  }

  // Get goal
  let goal = cliArgs.goal;
  if (!goal) {
    goal = await promptGoal();
  }
  if (!goal) {
    ui.printError("No goal provided. Exiting.");
    process.exit(1);
  }

  ui.printHeader();
  ui.startSpinner(`Connecting to appium-mcp (${config.MCP_TRANSPORT})...`);

  const mcpClient = await createMCPClient({
    transport: config.MCP_TRANSPORT,
    host: config.MCP_HOST,
    port: config.MCP_PORT,
  });

  const mcp = mcpClient;
  const logger = new SessionLogger(config.LOG_DIR);

  const modelName = config.LLM_MODEL || DEFAULT_MODELS[config.LLM_PROVIDER] || "default";

  // Set up recorder if --record flag
  const recorder = cliArgs.record ? new ActionRecorder(goal) : undefined;

  try {
    // Verify MCP connection and discover tools dynamically
    const availableTools = await mcpClient.listTools();
    ui.stopSpinner();
    console.log();

    // Create LLM provider with dynamic tool discovery
    const llm = createLLMProvider(config, availableTools);

    // Create Appium session (required before any device interaction)
    ui.startSpinner("Creating Appium session...");
    try {
      const sessionResult = await mcp.callTool("create_session", androidCreateSessionArgs(config));
      const resultText = extractText(sessionResult);
      if (resultText.toLowerCase().includes("error") || resultText.toLowerCase().includes("failed")) {
        throw new Error(resultText);
      }

      // Get the real physical screen size from device info.
      // The MCP tool appium_mobile_get_device_info calls /appium/device/info
      // which returns realDisplaySize (e.g. "720x1600") — physical pixels.
      try {
        const result = await mcp.callTool("appium_mobile_get_device_info", {});
        const text = extractText(result);
        // Match realDisplaySize in the response
        const sizeMatch = text.match(/realDisplaySize['":\s]+(\d+x\d+)/i);
        if (sizeMatch) {
          setDeviceScreenSize(sizeMatch[1]);
        } else {
          // Try JSON parse
          try {
            const info = JSON.parse(text);
            if (info.realDisplaySize) setDeviceScreenSize(info.realDisplaySize);
          } catch { /* not JSON */ }
        }
      } catch {
        // appium_mobile_get_device_info not available — will fall back to other methods
      }

      ui.stopSpinner();
      ui.printSetupOk("Appium session created");
    } catch (err: any) {
      ui.stopSpinner();
      ui.printSetupError(`Failed to create Appium session: ${err.message ?? err}`, "Make sure a device/emulator is connected: adb devices");
      process.exit(1);
    }

    // Fetch installed apps for name → package resolution
    const appResolver = new AppResolver();
    await appResolver.initialize(mcp);

    // ─── Always decompose goals into sub-goals ─────────
    ui.printPlanStart();
    const plannerModel = buildModel(config);
    const thinkingOptions = buildThinkingOptions(config);

    const planResult = await decomposeGoal(goal, plannerModel, thinkingOptions);
    const executor = createPlanExecutor(planResult.subGoals);
    ui.stopSpinner();

    if (planResult.isComplex) {
      ui.printPlan(planResult.subGoals, planResult.reasoning);
    } else {
      ui.printInfo("Simple goal — executing directly");
      console.log();
    }

    // Execute each sub-goal sequentially
    let subGoalIdx = 0;
    let totalSteps = 0;
    const allHistory: any[] = [];

    while (!executor.isDone()) {
      const subGoal = executor.current!;

      // Reset action history between sub-goals for clean context
      llm.resetHistory();

      // Each sub-goal gets a proportional share of max steps
      const stepsPerGoal = planResult.isComplex
        ? Math.max(10, Math.floor(config.MAX_STEPS / executor.all.length))
        : config.MAX_STEPS;

      // ─── Screen-aware orchestration ─────────────────────
      // Before executing, check the screen and decide: skip, rewrite, or proceed
      let effectiveGoal = subGoal.goal;

      if (planResult.isComplex && subGoalIdx > 0) {
        ui.startSpinner("Reconciling plan with device…", "orchestrator");
        try {
          // Capture DOM and/or screenshot for orchestration between sub-goals.
          // Match agent loop: skip XML when AGENT_MODE=vision (orchestrator uses screenshot).
          const captureScreenshot = config.VISION_MODE !== "never" || config.AGENT_MODE === "vision";
          const skipOrchestratorPageSource = config.AGENT_MODE === "vision";
          const screenState = await getScreenState(
            mcp,
            config.MAX_ELEMENTS,
            captureScreenshot,
            skipOrchestratorPageSource
          );
          const orchestratorDom =
            skipOrchestratorPageSource && !screenState.dom.trim()
              ? "(Vision mode: XML page source omitted — use the screenshot for visual state.)"
              : screenState.dom;

          const orchestratorScreenshot = await prepareScreenshotForLlm(
            screenState.screenshot,
            config.LLM_SCREENSHOT_MAX_EDGE_PX
          );

          // ─── Step 1: Screen readiness check ──────────────
          // Verify the screen is clean before evaluating the next sub-goal.
          // Detects leftover overlays, unconfirmed input, etc. from previous sub-goal.
          const prevGoal = executor.all[subGoalIdx - 1];
          if (prevGoal) {
            const readiness = await assessScreenReadiness(
              plannerModel,
              prevGoal.goal,
              subGoal.goal,
              orchestratorDom,
              thinkingOptions,
              orchestratorScreenshot,
            );

            if (!readiness.ready) {
              ui.stopSpinner();
              ui.printScreenReadiness(readiness.issues, readiness.suggestedAction);
              // If there's a suggested cleanup action, incorporate it into the goal
              if (readiness.suggestedAction) {
                effectiveGoal = `${readiness.suggestedAction}, then ${subGoal.goal}`;
                ui.printOrchestratorRewrite(subGoal.goal, effectiveGoal);
              }
              ui.startSpinner("Reconciling plan with device…", "orchestrator");
            }
          }

          // ─── Step 2: Sub-goal evaluation ─────────────────
          // Only if readiness didn't already rewrite the goal
          if (effectiveGoal === subGoal.goal) {
            const completedGoalsList = executor.all
              .filter(sg => sg.status === "completed")
              .map(sg => `${sg.goal} → ${sg.result}`);

            const decision = await evaluateSubGoal(
              plannerModel,
              goal,
              subGoal.goal,
              completedGoalsList,
              orchestratorDom,
              thinkingOptions,
              orchestratorScreenshot,
            );

            if (decision.action === "skip") {
              ui.stopSpinner();
              ui.printOrchestratorSkip(subGoal.goal, decision.reason);
              executor.markCompleted(decision.reason);
              subGoalIdx++;
              continue;
            }
            ui.stopSpinner();
            if (decision.action === "rewrite" && decision.rewrittenGoal) {
              ui.printOrchestratorRewrite(subGoal.goal, decision.rewrittenGoal);
              effectiveGoal = decision.rewrittenGoal;
            } else {
              ui.printOrchestratorProceed(subGoal.goal);
            }
          }
        } catch (err) {
          // Orchestrator failed — proceed with original goal
          ui.stopSpinner();
          ui.printWarning(`Orchestrator check failed: ${err}`);
        }
        ui.stopSpinner();
      }

      if (planResult.isComplex) {
        ui.printPlanContext(goal, effectiveGoal, executor.all, subGoalIdx);
      }

      // Build enriched goal with plan context so the LLM doesn't undo progress
      let enrichedGoal = effectiveGoal;
      if (planResult.isComplex) {
        const completedGoals = executor.all
          .filter(sg => sg.status === "completed")
          .map(sg => `✓ ${sg.goal} (${sg.result})`)
          .join("\n");
        const remainingGoals = executor.all
          .filter(sg => sg.status === "pending" && sg.index !== subGoal.index)
          .map(sg => `○ ${sg.goal}`)
          .join("\n");

        if (completedGoals) {
          enrichedGoal += `\n\nCONTEXT — Overall goal: "${goal}"\nAlready completed:\n${completedGoals}`;
          if (remainingGoals) {
            enrichedGoal += `\nStill pending (handled separately — NOT your job):\n${remainingGoals}`;
          }
          enrichedGoal += `\n\nIMPORTANT:`;
          enrichedGoal += `\n- Previous sub-goals are DONE. Do NOT navigate backwards or undo their work.`;
          enrichedGoal += `\n- ONLY perform actions for YOUR current sub-goal: "${effectiveGoal}". Do NOT perform actions for pending sub-goals — they will be handled separately after you call "done".`;
          enrichedGoal += `\n- Once YOUR sub-goal is achieved, call "done" IMMEDIATELY. Do NOT continue to the next step.`;
        }
      }

      const result = await runAgent({
        goal: enrichedGoal,
        displayGoal: effectiveGoal,
        mcp,
        llm,
        appResolver,
        maxSteps: stepsPerGoal,
        stepDelay: config.STEP_DELAY,
        maxElements: config.MAX_ELEMENTS,
        visionMode: config.VISION_MODE,
        recorder,
        modelName,
        onStep: (event) => {
          logger.logStep({
            step: event.step,
            action: event.decision.toolName,
            decision: event.decision,
            result: event.result.message,
            screenHash: "",
          });
        },
        // Screen evaluator: checks for unexpected states mid-execution
        screenEvaluator: planResult.isComplex
          ? (dom, currentGoal, _step) => evaluateScreen(plannerModel, currentGoal, dom, thinkingOptions)
          : undefined,
      });

      totalSteps += result.stepsUsed;
      allHistory.push(...result.history);

      if (result.success) {
        executor.markCompleted(result.reason);
      } else {
        executor.markFailed(result.reason);
        // Stop on failure for dependent sub-goals
        const nextGoal = executor.current;
        if (nextGoal?.dependsOn === subGoalIdx) {
          ui.printError("Dependent sub-goal cannot proceed", `Sub-goal ${subGoalIdx + 1} failed`);
          break;
        }
      }
      subGoalIdx++;
    }

    if (planResult.isComplex) {
      ui.printPlanSummary(executor.all);
    }

    const allDone = executor.all.every((sg) => sg.status === "completed");
    logger.finalize(goal, {
      success: allDone,
      reason: allDone ? "All sub-goals completed" : "Some sub-goals failed",
      stepsUsed: totalSteps,
      history: allHistory,
    });

    if (recorder) recorder.save(allDone);
    process.exit(allDone ? 0 : 1);
  } catch (err: any) {
    ui.stopSpinner();
    ui.printError("Fatal error", err?.message ?? String(err));
    process.exit(1);
  } finally {
    await mcpClient.close();
  }
}

async function promptGoal(): Promise<string> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    ui.printInteractiveHeader();
    rl.question("  Enter your goal: ", (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

main().catch(console.error);
