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

import { resolve } from 'path';
import { loadConfig } from './config.js';
import { createMCPClient } from './mcp/client.js';
import { createLLMProvider, buildModel, buildThinkingOptions } from './llm/provider.js';
import { getScreenState } from './perception/screen.js';
import { AppResolver } from './agent/app-resolver.js';
import { runAgent } from './agent/loop.js';
import { SessionLogger } from './logger.js';
import { ActionRecorder } from './recording/recorder.js';
import { loadRecording, replayRecording } from './recording/replayer.js';
import { parseFlowYamlFile, isSuiteYaml, parseSuiteYamlFile } from './flow/parse-yaml-flow.js';
import { runYamlFlow } from './flow/run-yaml-flow.js';
import { runFlowOnDevices, runSuite, printParallelSummary } from './flow/parallel-runner.js';
import { readFileSync } from 'fs';
import { loadEnvironmentFile, type VariableBindings } from './flow/variable-resolver.js';
import {
  decomposeGoal,
  createPlanExecutor,
  evaluateSubGoal,
  evaluateScreen,
  assessScreenReadiness,
} from './agent/planner.js';
import { RunArtifactCollector } from './report/writer.js';
import { startReportServer } from './report/server.js';
import { DEFAULT_MODELS } from './constants.js';
import { getStarkVisionModel } from './vision/locate-enabled.js';
import { prepareScreenshotForLlm } from './vision/prepare-screenshot-for-llm.js';
import { runExplorer } from './explorer/index.js';
import type { ExplorerConfig } from './explorer/types.js';
import { runPlayground } from './playground/index.js';
import { setupDevice } from './device/index.js';
import * as ui from './ui/terminal.js';
import { silenceTerminalUI } from './ui/terminal.js';
import { enableJsonMode, isJsonMode, emitJson } from './json-emitter.js';

export type Platform = 'android' | 'ios';
export type DeviceType = 'simulator' | 'real';

interface CLIArgs {
  goal: string;
  record: boolean;
  replay: string | null;
  flow: string | null;
  playground: boolean;
  plan: boolean;
  explore: string | null;
  report: boolean;
  reportPort: number;
  numFlows: number;
  noCrawl: boolean;
  outputDir: string;
  maxScreens: number;
  maxDepth: number;
  platform: Platform | null;
  deviceType: DeviceType | null;
  deviceUdid: string | null;
  deviceName: string | null;
  json: boolean;
  /** Environment name for variable/secret resolution (e.g. "dev", "staging") */
  env: string | null;
}

function printHelp(): void {
  const c = {
    flag: ui.theme.info,
    arg: ui.theme.warn,
    desc: ui.theme.dim,
    section: ui.theme.bold,
    example: ui.theme.white,
    comment: ui.theme.muted,
    brand: ui.theme.brand,
    env: ui.theme.success,
  };

  console.log();
  console.log(`  ${c.brand('appclaw')} ${c.desc('[options] [goal]')}`);
  console.log();

  // ── Platform & Device ──
  console.log(`  ${c.section('Platform & Device')}`);
  console.log(
    `    ${c.flag('--platform')} ${c.arg('<android|ios>')}     ${c.desc('Target platform (prompt on macOS, android elsewhere)')}`
  );
  console.log(
    `    ${c.flag('--device-type')} ${c.arg('<sim|real>')}     ${c.desc('iOS: simulator or real device')}`
  );
  console.log(
    `    ${c.flag('--device')} ${c.arg('<name>')}              ${c.desc('Device name, partial match (e.g. "iPhone 17 Pro")')}`
  );
  console.log(
    `    ${c.flag('--udid')} ${c.arg('<udid>')}                ${c.desc('Device UDID (skips picker)')}`
  );
  console.log();

  // ── Modes ──
  console.log(`  ${c.section('Modes')}`);
  console.log(
    `    ${c.flag('--flow')} ${c.arg('<file.yaml>')}           ${c.desc('Run declarative YAML steps (no LLM)')}`
  );
  console.log(
    `    ${c.flag('--env')} ${c.arg('<name>')}                 ${c.desc('Environment for variables/secrets (e.g. dev, staging)')}`
  );
  console.log(
    `    ${c.flag('--playground')}                    ${c.desc('Interactive REPL for building flows')}`
  );
  console.log(
    `    ${c.flag('--explore')} ${c.arg('<prd>')}              ${c.desc('Generate test flows from a PRD')}`
  );
  console.log(
    `    ${c.flag('--report')}                       ${c.desc('Start report server to view execution results')}`
  );
  console.log(
    `    ${c.flag('--report-port')} ${c.arg('<port>')}          ${c.desc('Report server port (default: 4173)')}`
  );
  console.log(
    `    ${c.flag('--record')}                       ${c.desc('Record goal execution for replay')}`
  );
  console.log(
    `    ${c.flag('--replay')} ${c.arg('<file>')}              ${c.desc('Replay a recorded session')}`
  );
  console.log();

  // ── Explorer ──
  console.log(`  ${c.section('Explorer Options')}`);
  console.log(
    `    ${c.flag('--num-flows')} ${c.arg('<N>')}              ${c.desc('Flows to generate (default: 5)')}`
  );
  console.log(
    `    ${c.flag('--no-crawl')}                     ${c.desc('Skip device crawling (PRD-only)')}`
  );
  console.log(
    `    ${c.flag('--output-dir')} ${c.arg('<dir>')}           ${c.desc('Output directory (default: generated-flows)')}`
  );
  console.log();

  // ── Examples ──
  console.log(`  ${c.section('Examples')}`);
  console.log();
  console.log(`    ${c.comment('# Android (default)')}`);
  console.log(`    ${c.example('appclaw "Open Settings"')}`);
  console.log();
  console.log(`    ${c.comment('# iOS Simulator (auto-selects booted sim)')}`);
  console.log(`    ${c.example('appclaw --platform ios --device-type simulator "Open Settings"')}`);
  console.log();
  console.log(`    ${c.comment('# iOS Simulator — pick device by name')}`);
  console.log(
    `    ${c.example('appclaw --platform ios --device-type simulator --device "iPhone 17 Pro" "Open Safari"')}`
  );
  console.log();
  console.log(`    ${c.comment('# iOS Real Device')}`);
  console.log(
    `    ${c.example('appclaw --platform ios --device-type real --udid 00008120-XXXX "Open Settings"')}`
  );
  console.log();
  console.log(`    ${c.comment('# Playground on iOS')}`);
  console.log(`    ${c.example('appclaw --playground --platform ios --device-type simulator')}`);
  console.log();
  console.log(`    ${c.comment('# YAML flow on Android')}`);
  console.log(`    ${c.example('appclaw --flow examples/flows/google-search.yaml')}`);
  console.log();
  console.log(`    ${c.comment('# View execution reports in browser')}`);
  console.log(`    ${c.example('appclaw --report')}`);
  console.log();

  // ── Env Vars ──
  console.log(`  ${c.section('Environment Variables')} ${c.desc('(CI-friendly, same as flags)')}`);
  console.log(
    `    ${c.env('PLATFORM')}${c.desc('=')}${c.arg('ios')}                ${c.desc('Same as --platform')}`
  );
  console.log(
    `    ${c.env('DEVICE_TYPE')}${c.desc('=')}${c.arg('simulator')}        ${c.desc('Same as --device-type')}`
  );
  console.log(
    `    ${c.env('DEVICE_UDID')}${c.desc('=')}${c.arg('<udid>')}           ${c.desc('Same as --udid')}`
  );
  console.log(
    `    ${c.env('DEVICE_NAME')}${c.desc('=')}${c.arg('<name>')}           ${c.desc('Same as --device')}`
  );
  console.log();
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log('0.1.0');
    process.exit(0);
  }

  let record = false;
  let replay: string | null = null;
  let flow: string | null = null;
  let playground = false;
  let plan = false;
  let explore: string | null = null;
  let report = false;
  let reportPort = 4173;
  let numFlows = 5;
  let noCrawl = false;
  let outputDir = 'generated-flows';
  let maxScreens = 10;
  let maxDepth = 3;
  let platform: Platform | null = null;
  let deviceType: DeviceType | null = null;
  let deviceUdid: string | null = null;
  let deviceName: string | null = null;
  let json = false;
  let env: string | null = null;
  const goalParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report') {
      report = true;
    } else if (args[i] === '--report-port') {
      reportPort = parseInt(args[++i] ?? '4173', 10) || 4173;
    } else if (args[i] === '--env') {
      env = args[++i] ?? null;
    } else if (args[i] === '--record') {
      record = true;
    } else if (args[i] === '--replay') {
      replay = args[++i] ?? null;
    } else if (args[i] === '--flow') {
      flow = args[++i] ?? null;
    } else if (args[i] === '--playground') {
      playground = true;
    } else if (args[i] === '--plan') {
      plan = true;
    } else if (args[i] === '--explore') {
      explore = args[++i] ?? null;
    } else if (args[i] === '--num-flows') {
      numFlows = parseInt(args[++i] ?? '5', 10) || 5;
    } else if (args[i] === '--no-crawl') {
      noCrawl = true;
    } else if (args[i] === '--output-dir') {
      outputDir = args[++i] ?? 'generated-flows';
    } else if (args[i] === '--max-screens') {
      maxScreens = parseInt(args[++i] ?? '10', 10) || 10;
    } else if (args[i] === '--max-depth') {
      maxDepth = parseInt(args[++i] ?? '3', 10) || 3;
    } else if (args[i] === '--platform') {
      const val = args[++i];
      if (val === 'android' || val === 'ios') platform = val;
      else {
        console.error(`Invalid --platform: ${val}. Use "android" or "ios".`);
        process.exit(1);
      }
    } else if (args[i] === '--device-type') {
      const val = args[++i];
      if (val === 'simulator' || val === 'real') deviceType = val;
      else {
        console.error(`Invalid --device-type: ${val}. Use "simulator" or "real".`);
        process.exit(1);
      }
    } else if (args[i] === '--udid') {
      deviceUdid = args[++i] ?? null;
    } else if (args[i] === '--device') {
      deviceName = args[++i] ?? null;
    } else if (args[i] === '--json') {
      json = true;
    } else {
      goalParts.push(args[i]);
    }
  }

  return {
    goal: goalParts.join(' ').trim(),
    record,
    replay,
    flow,
    playground,
    plan,
    explore,
    report,
    reportPort,
    numFlows,
    noCrawl,
    outputDir,
    maxScreens,
    maxDepth,
    platform,
    deviceType,
    deviceUdid,
    deviceName,
    json,
    env,
  };
}

async function main() {
  const cliArgs = parseArgs();
  if (cliArgs.json) {
    enableJsonMode();
    silenceTerminalUI();
  }
  await ui.initUI();
  const config = loadConfig();

  // ─── Report mode (serve execution reports) ──────────────
  if (cliArgs.report) {
    ui.printHeader();
    const reportProjectRoot = process.cwd();
    startReportServer({
      port: cliArgs.reportPort,
      projectRoot: reportProjectRoot,
      onListening: (port) => {
        const url = `http://localhost:${port}`;
        console.log();
        ui.printSetupOk(`Report server running at ${url}`);
        console.log();
        // Try to open browser
        import('child_process')
          .then(({ exec }) => {
            const cmd =
              process.platform === 'darwin'
                ? 'open'
                : process.platform === 'win32'
                  ? 'start'
                  : 'xdg-open';
            exec(`${cmd} ${url}`);
          })
          .catch(() => {});
      },
    });
    return; // Server keeps process alive
  }

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
    // JSON playground for IDE extensions
    if (isJsonMode()) {
      const { runPlaygroundJson } = await import('./playground/index.js');
      await runPlaygroundJson({
        platform: cliArgs.platform,
        deviceType: cliArgs.deviceType,
        udid: cliArgs.deviceUdid,
        deviceName: cliArgs.deviceName,
      });
      return;
    }
    await runPlayground({
      platform: cliArgs.platform,
      deviceType: cliArgs.deviceType,
      udid: cliArgs.deviceUdid,
      deviceName: cliArgs.deviceName,
    });
    return;
  }

  // ─── Explorer mode (PRD → flows) ─────────────────────────
  if (cliArgs.explore) {
    // Validate LLM API key
    if (config.LLM_PROVIDER !== 'ollama' && !config.LLM_API_KEY) {
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
        ui.printSetupOk('Connected to appium-mcp');

        // Full device setup pipeline (platform → device → iOS setup → session)
        await setupDevice(mcp, {
          cliPlatform: cliArgs.platform,
          cliDeviceType: cliArgs.deviceType,
          cliUdid: cliArgs.deviceUdid,
          cliDeviceName: cliArgs.deviceName,
          config,
        });
      } catch (err: any) {
        ui.stopSpinner();
        ui.printWarning(
          `Device connection failed: ${err?.message ?? err}. Continuing without crawling.`
        );
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

  // ─── YAML flow / suite mode ────────────────────────────
  if (cliArgs.flow) {
    ui.printHeader();
    ui.printYamlFlowHeader(cliArgs.flow);

    // ── Resolve variable bindings (flow mode only; suites inherit per-flow env) ──
    let bindings: VariableBindings | undefined;
    if (cliArgs.env) {
      const envDir = resolve(process.cwd(), '.appclaw', 'env');
      const envFile = resolve(envDir, `${cliArgs.env}.yaml`);
      try {
        bindings = loadEnvironmentFile(envFile);
        ui.printSetupOk(`Loaded environment: ${cliArgs.env}`);
      } catch (err) {
        ui.printError(
          `Failed to load environment "${cliArgs.env}"`,
          err instanceof Error ? err.message : String(err)
        );
        process.exit(1);
      }
    }

    // ── Detect suite vs single flow ──
    let fileContent: string;
    try {
      fileContent = readFileSync(cliArgs.flow, 'utf-8');
    } catch (err) {
      ui.printError(
        'Cannot read file',
        `${cliArgs.flow}: ${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
    }

    const isSuite = isSuiteYaml(fileContent);

    // ── Base device setup args (shared between suite and flow paths) ──
    const baseSetupArgs = {
      cliPlatform: cliArgs.platform,
      cliDeviceType: cliArgs.deviceType,
      cliUdid: cliArgs.deviceUdid,
      cliDeviceName: cliArgs.deviceName,
      config,
    };

    // ══════════════════════════════════════════════════════════════════
    // SUITE mode — a YAML listing other flow YAML files
    // ══════════════════════════════════════════════════════════════════
    if (isSuite) {
      let suite;
      try {
        suite = parseSuiteYamlFile(cliArgs.flow);
      } catch (err) {
        ui.printError('Invalid suite YAML', String(err));
        process.exit(1);
      }

      const parallelCount = Math.max(1, suite.meta.parallel ?? 1);
      const suitePlatform = cliArgs.platform ?? suite.meta.platform ?? null;

      try {
        const suiteResult = await runSuite(
          suite,
          parallelCount,
          { ...baseSetupArgs, cliPlatform: suitePlatform },
          config,
          { stepDelayMs: config.STEP_DELAY }
        );

        printParallelSummary(suiteResult);

        emitJson({
          event: 'suite_done',
          data: {
            success: suiteResult.allPassed,
            passedCount: suiteResult.passedCount,
            failedCount: suiteResult.failedCount,
            workers: suiteResult.workers.map((w) => ({
              flowFile: w.flowFile,
              deviceName: w.deviceName,
              success: w.result.success,
              stepsExecuted: w.result.stepsExecuted,
              stepsTotal: w.result.stepsTotal,
              reason: w.error ?? w.result.reason,
            })),
          },
        });
        process.exit(suiteResult.allPassed ? 0 : 1);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emitJson({ event: 'error', data: { message: `Suite execution error: ${msg}` } });
        emitJson({
          event: 'suite_done',
          data: { success: false, passedCount: 0, failedCount: 0, reason: msg },
        });
        process.exit(1);
      }
      return;
    }

    // ══════════════════════════════════════════════════════════════════
    // FLOW mode — single YAML flow (possibly parallel: N)
    // ══════════════════════════════════════════════════════════════════
    let parsed;
    try {
      parsed = await parseFlowYamlFile(cliArgs.flow, bindings ? { bindings } : {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitJson({ event: 'error', data: { message: `Invalid flow YAML: ${msg}` } });
      ui.printError('Invalid flow YAML', String(err));
      process.exit(1);
    }

    const flowCliPlatform = cliArgs.platform ?? parsed.meta.platform ?? null;
    const parallelCount = parsed.meta.parallel ?? 1;

    // ── Parallel flow: same flow on N devices ──
    if (parallelCount > 1) {
      emitJson({ event: 'connected', data: { transport: config.MCP_TRANSPORT } });
      try {
        const parallelResult = await runFlowOnDevices(
          cliArgs.flow,
          parsed,
          parallelCount,
          { ...baseSetupArgs, cliPlatform: flowCliPlatform },
          config,
          { stepDelayMs: config.STEP_DELAY }
        );

        printParallelSummary(parallelResult);

        emitJson({
          event: 'parallel_done',
          data: {
            success: parallelResult.allPassed,
            passedCount: parallelResult.passedCount,
            failedCount: parallelResult.failedCount,
            workers: parallelResult.workers.map((w) => ({
              deviceName: w.deviceName,
              success: w.result.success,
              stepsExecuted: w.result.stepsExecuted,
              stepsTotal: w.result.stepsTotal,
              reason: w.error ?? w.result.reason,
            })),
          },
        });
        process.exit(parallelResult.allPassed ? 0 : 1);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emitJson({ event: 'error', data: { message: `Parallel flow error: ${msg}` } });
        emitJson({
          event: 'parallel_done',
          data: { success: false, passedCount: 0, failedCount: 0, reason: msg },
        });
        process.exit(1);
      }
      return;
    }

    // ── Single device flow (original path) ──
    const mcpClient = await createMCPClient({
      transport: config.MCP_TRANSPORT,
      host: config.MCP_HOST,
      port: config.MCP_PORT,
    });
    const mcp = mcpClient;

    try {
      let flowPlatform: 'android' | 'ios' = 'android';
      let flowDeviceUdid: string | undefined;
      emitJson({ event: 'connected', data: { transport: config.MCP_TRANSPORT } });
      let flowScopedMcp = mcp;
      try {
        const deviceResult = await setupDevice(mcp, {
          ...baseSetupArgs,
          cliPlatform: flowCliPlatform,
        });
        flowPlatform = deviceResult.platform;
        flowDeviceUdid = deviceResult.deviceUdid;
        flowScopedMcp = deviceResult.scopedMcp;
        emitJson({ event: 'device_ready', data: { platform: flowPlatform } });
      } catch (err: unknown) {
        ui.stopSpinner();
        const msg = err instanceof Error ? err.message : String(err);
        emitJson({ event: 'error', data: { message: `Device setup failed: ${msg}` } });
        ui.printSetupError(`Device setup failed: ${msg}`, 'Check device connection and try again.');
        process.exit(1);
      }

      const flowAppResolver = new AppResolver();
      await flowAppResolver.initialize(flowScopedMcp, flowPlatform);

      const onFlowStep = isJsonMode()
        ? (
            step: number,
            total: number,
            kind: string,
            target: string | undefined,
            status: 'running' | 'passed' | 'failed',
            error?: string,
            message?: string
          ) => {
            emitJson({
              event: 'flow_step',
              data: { step, total, kind, target, status, error, message },
            });
          }
        : undefined;

      const artifactCollector = new RunArtifactCollector(
        resolve(cliArgs.flow),
        parsed.meta,
        flowPlatform
      );

      const result = await runYamlFlow(
        flowScopedMcp,
        parsed.meta,
        parsed.steps,
        {
          stepDelayMs: config.STEP_DELAY,
          appResolver: flowAppResolver,
          onFlowStep,
          artifactCollector,
          deviceUdid: flowDeviceUdid,
        },
        parsed.phases
      );

      try {
        const runId = await artifactCollector.finalize(process.cwd(), result);
        ui.printSetupOk(`Report saved: .appclaw/runs/${runId}`);
      } catch (err) {
        ui.printWarning(`Failed to save report: ${err instanceof Error ? err.message : err}`);
      }

      emitJson({
        event: 'flow_done',
        data: {
          success: result.success,
          stepsExecuted: result.stepsExecuted,
          stepsTotal: result.stepsTotal,
          failedAt: result.failedAt,
          reason: result.reason,
          failedPhase: result.failedPhase,
          phaseResults: result.phaseResults,
        },
      });
      try {
        await mcp.callTool('delete_session', {});
      } catch {
        /* ignore */
      }
      await mcpClient.close();
      process.exit(result.success ? 0 : 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      emitJson({ event: 'error', data: { message: `Flow execution error: ${msg}` } });
      emitJson({
        event: 'flow_done',
        data: { success: false, stepsExecuted: 0, stepsTotal: 0, reason: msg },
      });
      try {
        await mcp.callTool('delete_session', {});
      } catch {
        /* ignore */
      }
      await mcpClient.close();
      process.exit(1);
    }
    return;
  }

  // ─── Normal / Record / Plan mode ──────────────────────

  // Validate LLM API key
  if (config.LLM_PROVIDER !== 'ollama' && !config.LLM_API_KEY) {
    ui.printError(
      `LLM_API_KEY is required for provider "${config.LLM_PROVIDER}".`,
      `Set it in .env or as an environment variable.`
    );
    process.exit(1);
  }

  // Get goal (and optionally platform) via interactive prompt
  let goal = cliArgs.goal;
  if (!goal) {
    ui.printInteractiveHeader();

    // If no platform specified via CLI/env, let the user pick one upfront
    if (!cliArgs.platform && !config.PLATFORM) {
      const { promptPlatformInline } = await import('./device/platform-picker.js');
      const picked = await promptPlatformInline();
      if (picked) cliArgs.platform = picked;
    }

    goal = await promptGoal(false);
  }
  if (!goal) {
    ui.printError('No goal provided. Exiting.');
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

  const modelName = config.LLM_MODEL || DEFAULT_MODELS[config.LLM_PROVIDER] || 'default';

  // Set up recorder if --record flag
  const recorder = cliArgs.record ? new ActionRecorder(goal) : undefined;

  try {
    // Verify MCP connection and discover tools dynamically
    const availableTools = await mcpClient.listTools();
    ui.stopSpinner();
    emitJson({ event: 'connected', data: { transport: config.MCP_TRANSPORT } });
    console.log();

    // Create LLM provider with dynamic tool discovery
    const llm = createLLMProvider(config, availableTools);

    // Full device setup pipeline (platform → device → iOS setup → session)
    let resolvedPlatform: 'android' | 'ios' = 'android';
    let agentScopedMcp = mcp;
    try {
      const deviceResult = await setupDevice(mcp, {
        cliPlatform: cliArgs.platform,
        cliDeviceType: cliArgs.deviceType,
        cliUdid: cliArgs.deviceUdid,
        cliDeviceName: cliArgs.deviceName,
        config,
      });
      resolvedPlatform = deviceResult.platform;
      agentScopedMcp = deviceResult.scopedMcp;
      emitJson({ event: 'device_ready', data: { platform: resolvedPlatform } });
    } catch (err: any) {
      ui.stopSpinner();
      emitJson({ event: 'error', data: { message: `Device setup failed: ${err.message ?? err}` } });
      ui.printSetupError(
        `Device setup failed: ${err.message ?? err}`,
        'Check device connection and try again.'
      );
      process.exit(1);
    }

    // Fetch installed apps for name → package resolution
    const appResolver = new AppResolver();
    await appResolver.initialize(agentScopedMcp, resolvedPlatform);

    // ─── Always decompose goals into sub-goals ─────────
    ui.printPlanStart();
    const plannerModel = buildModel(config);
    const thinkingOptions = buildThinkingOptions(config);

    const planResult = await decomposeGoal(goal, plannerModel, thinkingOptions);
    const executor = createPlanExecutor(planResult.subGoals);
    ui.stopSpinner();

    emitJson({
      event: 'plan',
      data: {
        goal,
        subGoals: planResult.subGoals.map((sg) => sg.goal),
        isComplex: planResult.isComplex,
      },
    });

    if (planResult.isComplex) {
      ui.printPlan(planResult.subGoals, planResult.reasoning);
    } else {
      ui.printInfo('Simple goal — executing directly');
      console.log();
    }

    // Execute each sub-goal sequentially
    let subGoalIdx = 0;
    let totalSteps = 0;
    let journeyInputTokens = 0;
    let journeyOutputTokens = 0;
    let journeyCost = 0;
    const allHistory: any[] = [];

    // ── Episodic memory: detect app ID for the journey ──
    // Try to resolve the primary app from the goal so all sub-goals share it.
    let journeyAppId: string | undefined;
    try {
      const { extractAppIdFromText } = await import('./memory/fingerprint.js');
      // First try the raw goal for package names
      journeyAppId = extractAppIdFromText(goal);
      // If not found, try resolving app names from the goal (e.g., "YouTube" → "com.google.android.youtube")
      if (!journeyAppId) {
        const appMatch = goal.match(
          /(?:open|launch|start)\s+(?:the\s+)?(\w[\w\s]*?)(?:\s+app|\s+and\b)/i
        );
        if (appMatch) {
          journeyAppId = appResolver.resolve(appMatch[1].trim()) ?? undefined;
        }
      }
    } catch {
      // Non-critical
    }

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
        ui.startSpinner('Reconciling plan with device…', 'orchestrator');
        try {
          // Capture DOM and/or screenshot for orchestration between sub-goals.
          // Match agent loop: skip XML when AGENT_MODE=vision (orchestrator uses screenshot).
          const captureScreenshot =
            config.VISION_MODE !== 'never' || config.AGENT_MODE === 'vision';
          const skipOrchestratorPageSource = config.AGENT_MODE === 'vision';
          const screenState = await getScreenState(
            agentScopedMcp,
            config.MAX_ELEMENTS,
            captureScreenshot,
            skipOrchestratorPageSource
          );
          const orchestratorDom =
            skipOrchestratorPageSource && !screenState.dom.trim()
              ? '(Vision mode: XML page source omitted — use the screenshot for visual state.)'
              : screenState.dom;

          const orchestratorScreenshot = await prepareScreenshotForLlm(
            screenState.screenshot,
            config.LLM_SCREENSHOT_MAX_EDGE_PX
          );

          // ─── Parallel: Screen readiness + Sub-goal evaluation ──
          // Run both checks in parallel — they're independent.
          // If readiness rewrites the goal, we skip the evaluation result.
          const prevGoal = executor.all[subGoalIdx - 1];
          const completedGoalsList = executor.all
            .filter((sg) => sg.status === 'completed')
            .map((sg) => `${sg.goal} → ${sg.result}`);

          const [readiness, decision] = await Promise.all([
            prevGoal
              ? assessScreenReadiness(
                  plannerModel,
                  prevGoal.goal,
                  subGoal.goal,
                  orchestratorDom,
                  thinkingOptions,
                  orchestratorScreenshot
                )
              : Promise.resolve({ ready: true, issues: [] as string[] } as {
                  ready: boolean;
                  issues: string[];
                  suggestedAction?: string;
                }),
            evaluateSubGoal(
              plannerModel,
              goal,
              subGoal.goal,
              completedGoalsList,
              orchestratorDom,
              thinkingOptions,
              orchestratorScreenshot
            ),
          ]);

          // Apply readiness result
          if (readiness && !readiness.ready) {
            ui.stopSpinner();
            ui.printScreenReadiness(readiness.issues, readiness.suggestedAction);
            if (readiness.suggestedAction) {
              effectiveGoal = `${readiness.suggestedAction}, then ${subGoal.goal}`;
              ui.printOrchestratorRewrite(subGoal.goal, effectiveGoal);
            }
            ui.startSpinner('Reconciling plan with device…', 'orchestrator');
          }

          // Apply evaluation result (only if readiness didn't already rewrite)
          if (effectiveGoal === subGoal.goal) {
            if (decision.action === 'skip') {
              ui.stopSpinner();
              ui.printOrchestratorSkip(subGoal.goal, decision.reason);
              executor.markCompleted(decision.reason);
              subGoalIdx++;
              continue;
            }
            ui.stopSpinner();
            if (decision.action === 'rewrite' && decision.rewrittenGoal) {
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
          .filter((sg) => sg.status === 'completed')
          .map((sg) => `✓ ${sg.goal} (${sg.result})`)
          .join('\n');
        const remainingGoals = executor.all
          .filter((sg) => sg.status === 'pending' && sg.index !== subGoal.index)
          .map((sg) => `○ ${sg.goal}`)
          .join('\n');

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

      emitJson({
        event: 'goal_start',
        data: { goal: effectiveGoal, subGoalIndex: subGoalIdx, totalSubGoals: executor.all.length },
      });

      const result = await runAgent({
        goal: enrichedGoal,
        displayGoal: effectiveGoal,
        mcp: agentScopedMcp,
        llm,
        appResolver,
        appId: journeyAppId,
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
            screenHash: '',
          });
          emitJson({
            event: 'step',
            data: {
              step: event.step,
              action: event.decision.toolName,
              target: event.decision.args?.element as string | undefined,
              args: event.decision.args,
              success: event.result.success,
              message: event.result.message,
            },
          });
          // Stream device screenshot after each step
          if (event.screenshot) {
            emitJson({
              event: 'screen',
              data: { screenshot: event.screenshot, elementCount: event.elementsCount },
            });
          }
        },
        // Screen evaluator: checks for unexpected states mid-execution
        screenEvaluator: planResult.isComplex
          ? (dom, currentGoal, _step) =>
              evaluateScreen(plannerModel, currentGoal, dom, thinkingOptions)
          : undefined,
      });

      totalSteps += result.stepsUsed;
      allHistory.push(...result.history);
      if (result.totalTokens) {
        journeyInputTokens += result.totalTokens.input;
        journeyOutputTokens += result.totalTokens.output;
        journeyCost += result.totalTokens.cost;
      }

      emitJson({
        event: 'goal_done',
        data: {
          goal: effectiveGoal,
          success: result.success,
          reason: result.reason,
          stepsUsed: result.stepsUsed,
        },
      });

      if (result.success) {
        executor.markCompleted(result.reason);
      } else {
        executor.markFailed(result.reason);
        // Stop on failure for dependent sub-goals
        const nextGoal = executor.current;
        if (nextGoal?.dependsOn === subGoalIdx) {
          ui.printError('Dependent sub-goal cannot proceed', `Sub-goal ${subGoalIdx + 1} failed`);
          break;
        }
      }
      subGoalIdx++;
    }

    if (planResult.isComplex) {
      ui.printPlanSummary(executor.all);
    }

    // Print journey-level token totals
    ui.printJourneyTokenSummary(
      journeyInputTokens,
      journeyOutputTokens,
      journeyCost,
      totalSteps,
      modelName
    );

    const allDone = executor.all.every((sg) => sg.status === 'completed');
    emitJson({
      event: 'done',
      data: { success: allDone, totalSteps, totalCost: journeyCost || undefined },
    });
    logger.finalize(goal, {
      success: allDone,
      reason: allDone ? 'All sub-goals completed' : 'Some sub-goals failed',
      stepsUsed: totalSteps,
      history: allHistory,
    });

    if (recorder) recorder.save(allDone);
    try {
      await mcpClient.callTool('delete_session', {});
    } catch {
      /* ignore */
    }
    await mcpClient.close();
    process.exit(allDone ? 0 : 1);
  } catch (err: any) {
    ui.stopSpinner();
    emitJson({
      event: 'error',
      data: { message: err?.message ?? String(err), detail: err?.stack },
    });
    ui.printError('Fatal error', err?.message ?? String(err));
    try {
      await mcpClient.callTool('delete_session', {});
    } catch {
      /* ignore */
    }
    await mcpClient.close();
    process.exit(1);
  }
}

async function promptGoal(showHeader = true): Promise<string> {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    if (showHeader) ui.printInteractiveHeader();
    rl.question('  Enter your goal: ', (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

main().catch(console.error);
