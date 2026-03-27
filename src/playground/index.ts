/**
 * Playground — interactive REPL that connects to a real device,
 * executes commands live, and records steps for YAML export.
 *
 * Type natural-language commands (tap, swipe, type, etc.)
 * → each one runs immediately on the device via Appium
 * → accumulated steps can be exported as a YAML flow file.
 */

import readline from "node:readline";
import { writeFileSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { stringify } from "yaml";

import { loadConfig, Config } from "../config.js";
import { createMCPClient } from "../mcp/client.js";
import { extractText } from "../mcp/tools.js";
import { androidCreateSessionArgs } from "../mcp/session-caps.js";
import { AppResolver } from "../agent/app-resolver.js";
import { tryParseNaturalFlowLine } from "../flow/natural-line.js";
import { classifyInstruction } from "../flow/llm-parser.js";
import { visionExecute } from "../flow/vision-execute.js";
import type { FlowStep, FlowMeta } from "../flow/types.js";
import type { MCPClient } from "../mcp/types.js";
import { theme, printBox, printPanel, printTable, hr, appGradient, printMarkdown, progressBar } from "../ui/terminal.js";
import * as ui from "../ui/terminal.js";
import Table from "cli-table3";

import {
  executeStep,
  type FlowTapPollOptions,
} from "../flow/run-yaml-flow.js";

// ─── State ──────────────────────────────────────────────

interface PlaygroundState {
  steps: FlowStep[];
  meta: FlowMeta;
  mcp: MCPClient | null;
  appResolver: AppResolver | null;
}

const state: PlaygroundState = {
  steps: [],
  meta: {},
  mcp: null,
  appResolver: null,
};

// ─── Formatting helpers ─────────────────────────────────

/** Short action word for a step kind */
function stepAction(step: FlowStep): string {
  switch (step.kind) {
    case "launchApp":    return "launch";
    case "openApp":      return "open";
    case "tap":          return "tap";
    case "type":         return "type";
    case "swipe":        return "swipe";
    case "wait":         return "wait";
    case "enter":        return "enter";
    case "back":         return "back";
    case "home":         return "home";
    case "assert":       return "assert";
    case "scrollAssert": return "scroll";
    case "getInfo":      return "info";
    case "done":         return "done";
  }
}

/** Target description for a step */
function stepTarget(step: FlowStep): string {
  switch (step.kind) {
    case "launchApp":    return "app";
    case "openApp":      return step.query;
    case "tap":          return `"${step.label}"`;
    case "type":         return `"${step.text}"${step.target ? ` → ${step.target}` : ""}`;
    case "swipe":        return step.direction;
    case "wait":         return `${step.seconds}s`;
    case "enter":        return "";
    case "back":         return "";
    case "home":         return "";
    case "assert":       return `"${step.text}"`;
    case "scrollAssert": return `"${step.text}" ${step.direction} ×${step.maxScrolls}`;
    case "getInfo":      return `"${step.query}"`;
    case "done":         return step.message ?? "";
  }
}

function stepToDisplay(step: FlowStep, index: number): string {
  const num = theme.brand(`${(index + 1).toString().padStart(2)}.`);
  const action = theme.step.bold(stepAction(step).padEnd(7));
  const target = theme.white(stepTarget(step));
  return `${num} ${action} ${target}`;
}

function spinnerDetail(step: FlowStep): string {
  switch (step.kind) {
    case "tap":           return "tapping the screen…";
    case "type":          return "typing into the field…";
    case "swipe":         return "swiping the screen…";
    case "scrollAssert":  return "scanning the screen…";
    case "assert":        return "verifying the screen…";
    case "launchApp":     return "launching the app…";
    case "openApp":       return "opening the app…";
    case "wait":          return "waiting…";
    case "enter":         return "pressing enter…";
    case "back":          return "navigating back…";
    case "home":          return "going home…";
    case "getInfo":       return "reading the screen…";
    case "done":          return "wrapping up…";
    default:              return "executing on device…";
  }
}

function printStepResult(stepNum: number, step: FlowStep, success: boolean, message: string): void {
  const action = stepAction(step);
  const target = stepTarget(step);
  const icon = success ? theme.success("✓") : theme.error("✗");

  const actionBadge = success
    ? chalk.bgHex("#7C6FFF").white.bold(` ${action} `)
    : chalk.bgRed.white.bold(` ${action} `);

  const statusDot = success
    ? chalk.green("●")
    : chalk.red("●");

  // Compact single block
  console.log(`  ${icon} ${theme.dim(`#${stepNum}`)} ${actionBadge} ${theme.white(target)}`);
  if (message) {
    console.log(`    ${statusDot} ${success ? theme.success(message) : theme.error(message)}`);
  }
}

function printStepSuccess(stepNum: number, step: FlowStep, message: string): void {
  printStepResult(stepNum, step, true, message);
}

function printStepFail(stepNum: number, step: FlowStep, message: string): void {
  printStepResult(stepNum, step, false, message);
}

/** Convert step to YAML — preserve the user's original natural language input. */
function stepToYaml(step: FlowStep): unknown {
  // Playground steps always have verbatim (the exact text the user typed).
  // Use it directly so the YAML reads like the user's instructions.
  if (step.verbatim) return step.verbatim;

  // Fallback for steps without verbatim (shouldn't happen in playground)
  switch (step.kind) {
    case "launchApp":    return "launchApp";
    case "openApp":      return `open ${step.query} app`;
    case "tap":          return `tap ${step.label}`;
    case "type":         return `type "${step.text}"`;
    case "swipe":        return `swipe ${step.direction}`;
    case "wait":         return `wait ${step.seconds} s`;
    case "enter":        return "press enter";
    case "back":         return "go back";
    case "home":         return "go home";
    case "assert":       return `assert "${step.text}" is visible`;
    case "scrollAssert": return `scroll ${step.direction} until "${step.text}" is visible`;
    case "getInfo":      return `getInfo: ${step.query}`;
    case "done":         return step.message ? `done: ${step.message}` : "done";
  }
}

function buildYamlString(): string {
  const parts: string[] = [];

  if (state.meta.appId || state.meta.name) {
    const metaObj: Record<string, string> = {};
    if (state.meta.appId) metaObj.appId = state.meta.appId;
    if (state.meta.name) metaObj.name = state.meta.name;
    parts.push(stringify(metaObj).trim());
    parts.push("---");
  }

  const yamlSteps = state.steps.map(stepToYaml);
  parts.push(stringify(yamlSteps).trim());

  return parts.join("\n") + "\n";
}

function printStepList(): void {
  if (state.steps.length === 0) return;

  const title = state.meta.name
    ? `${state.meta.name}${state.meta.appId ? ` (${state.meta.appId})` : ""}`
    : state.meta.appId
      ? state.meta.appId
      : "Flow";

  const table = new Table({
    head: [
      chalk.hex("#9CA3AF")("#"),
      chalk.hex("#9CA3AF")("Action"),
      chalk.hex("#9CA3AF")("Target"),
      chalk.hex("#9CA3AF")("Status"),
    ],
    style: { head: [], border: ["gray"] },
    chars: {
      "top": "─", "top-mid": "┬", "top-left": "╭", "top-right": "╮",
      "bottom": "─", "bottom-mid": "┴", "bottom-left": "╰", "bottom-right": "╯",
      "left": "│", "left-mid": "├", "mid": "─", "mid-mid": "┼",
      "right": "│", "right-mid": "┤", "middle": "│",
    },
    colWidths: [5, 10, 40, 10],
    wordWrap: true,
  });

  for (let i = 0; i < state.steps.length; i++) {
    const step = state.steps[i];
    const action = stepAction(step);
    const target = stepTarget(step);
    const actionColored = chalk.hex("#6CB6FF").bold(action);
    const statusColored = chalk.green("● pass");

    table.push([
      chalk.hex("#7C6FFF")(`${i + 1}`),
      actionColored,
      chalk.white(target),
      statusColored,
    ]);
  }

  console.log();
  console.log(`  ${chalk.hex("#7C6FFF").bold(title)}`);
  console.log(`  ${table.toString().split("\n").join("\n  ")}`);
  console.log();
  console.log(`  ${chalk.green("✓")} ${chalk.green.bold(`${state.steps.length}`)} ${chalk.dim(`step${state.steps.length === 1 ? "" : "s"} recorded`)}  ${progressBar(state.steps.length, state.steps.length, 15)}`);
  console.log();
}

// ─── Step execution ─────────────────────────────────────

async function runStepOnDevice(step: FlowStep): Promise<{ success: boolean; message: string }> {
  if (!state.mcp) {
    return { success: false, message: "Not connected to device" };
  }

  const tapPoll: FlowTapPollOptions = { maxAttempts: 3, intervalMs: 300 };
  return executeStep(state.mcp, step, state.meta, state.appResolver ?? undefined, tapPoll);
}

// ─── Slash commands ─────────────────────────────────────

const COMMANDS: Record<string, { desc: string; run: (arg: string) => Promise<void> | void }> = {
  "/help": {
    desc: "Show available commands and supported step patterns",
    run: () => printHelp(),
  },
  "/list": {
    desc: "List all recorded steps",
    run: () => {
      if (state.steps.length === 0) {
        console.log(`\n  ${theme.dim("No steps yet. Type a command like:")} ${theme.white("open youtube app")}\n`);
        return;
      }
      printStepList();
    },
  },
  "/yaml": {
    desc: "Preview the YAML output",
    run: () => {
      if (state.steps.length === 0) {
        console.log(`\n  ${theme.dim("No steps to preview.")}\n`);
        return;
      }
      const yamlStr = buildYamlString();
      console.log();
      printMarkdown("```yaml\n" + yamlStr + "```");
      console.log(`  ${theme.dim("Use")} ${theme.info("/export <file>")} ${theme.dim("to save")}`);
      console.log();
    },
  },
  "/export": {
    desc: "Export steps to a YAML file (e.g. /export my-flow.yaml)",
    run: (arg: string) => {
      if (state.steps.length === 0) {
        console.log(`\n  ${theme.error("✗")} No steps to export.\n`);
        return;
      }
      const filename = arg.trim() || `flow-${Date.now()}.yaml`;
      const filepath = filename.startsWith("/") ? filename : path.resolve(process.cwd(), filename);
      const yamlStr = buildYamlString();
      writeFileSync(filepath, yamlStr, "utf-8");
      const exportContent = [
        `${chalk.green.bold(`${state.steps.length}`)} ${chalk.dim("steps exported")}`,
        "",
        `${chalk.dim("File:")} ${chalk.white(filepath)}`,
        `${chalk.dim("Run:")}  ${chalk.cyan(`appclaw --flow ${path.relative(process.cwd(), filepath)}`)}`,
      ].join("\n");
      console.log();
      printBox(exportContent, { title: "Exported", titleAlignment: "left", borderColor: "#22C55E" });
      console.log();
    },
  },
  "/undo": {
    desc: "Remove the last step",
    run: () => {
      if (state.steps.length === 0) {
        console.log(`  ${theme.dim("Nothing to undo.")}`);
        return;
      }
      const removed = state.steps.pop()!;
      console.log(`  ${theme.warn("↩")} Removed: ${theme.dim(removed.verbatim ?? removed.kind)}`);
      if (state.steps.length > 0) {
        printStepList();
      } else {
        console.log(`  ${theme.dim("All steps cleared.")}`);
      }
    },
  },
  "/clear": {
    desc: "Clear all steps and metadata",
    run: () => {
      const count = state.steps.length;
      state.steps.length = 0;
      state.meta = {};
      console.log(`  ${theme.warn("↩")} Cleared ${count} steps.`);
    },
  },
  "/meta": {
    desc: "Set flow metadata (e.g. /meta appId com.android.settings)",
    run: (arg: string) => {
      const parts = arg.trim().split(/\s+/);
      const key = parts[0];
      const value = parts.slice(1).join(" ");
      if (key === "appId" && value) {
        state.meta.appId = value;
        console.log(`  ${theme.success("✓")} appId = ${theme.white(value)}`);
      } else if (key === "name" && value) {
        state.meta.name = value;
        console.log(`  ${theme.success("✓")} name = ${theme.white(value)}`);
      } else {
        console.log(`  ${theme.label("Usage:")} /meta appId <package.id>  or  /meta name <flow name>`);
        if (state.meta.appId || state.meta.name) {
          console.log(`  ${theme.label("Current:")}`);
          if (state.meta.appId) console.log(`    appId: ${theme.white(state.meta.appId)}`);
          if (state.meta.name) console.log(`    name:  ${theme.white(state.meta.name)}`);
        }
      }
    },
  },
  "/edit": {
    desc: "Edit a step by number (e.g. /edit 3 tap \"Settings\")",
    run: (arg: string) => {
      const match = arg.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        console.log(`  ${theme.label("Usage:")} /edit <number> <new command>`);
        return;
      }
      const idx = parseInt(match[1], 10) - 1;
      if (idx < 0 || idx >= state.steps.length) {
        console.log(`  ${theme.error("✗")} Step ${idx + 1} does not exist (1–${state.steps.length}).`);
        return;
      }
      const parsed = tryParseNaturalFlowLine(match[2]);
      if (!parsed) {
        console.log(`  ${theme.error("✗")} Could not parse: ${theme.dim(match[2])}`);
        return;
      }
      state.steps[idx] = parsed;
      console.log(`  ${theme.success("✓")} Updated step ${idx + 1}`);
      printStepList();
    },
  },
  "/insert": {
    desc: "Insert a step at position (e.g. /insert 2 wait 3 s)",
    run: (arg: string) => {
      const match = arg.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        console.log(`  ${theme.label("Usage:")} /insert <position> <command>`);
        return;
      }
      const idx = parseInt(match[1], 10) - 1;
      if (idx < 0 || idx > state.steps.length) {
        console.log(`  ${theme.error("✗")} Position must be 1–${state.steps.length + 1}.`);
        return;
      }
      const parsed = tryParseNaturalFlowLine(match[2]);
      if (!parsed) {
        console.log(`  ${theme.error("✗")} Could not parse: ${theme.dim(match[2])}`);
        return;
      }
      state.steps.splice(idx, 0, parsed);
      console.log(`  ${theme.success("✓")} Inserted at position ${idx + 1}`);
      printStepList();
    },
  },
  "/delete": {
    desc: "Delete a step by number (e.g. /delete 3)",
    run: (arg: string) => {
      const idx = parseInt(arg.trim(), 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= state.steps.length) {
        console.log(`  ${theme.error("✗")} Invalid step number. Use 1–${state.steps.length}.`);
        return;
      }
      const removed = state.steps.splice(idx, 1)[0];
      console.log(`  ${theme.warn("↩")} Deleted: ${theme.dim(removed.verbatim ?? removed.kind)}`);
      if (state.steps.length > 0) {
        printStepList();
      }
    },
  },
};

function printHelp(): void {
  console.log();
  console.log(hr("single", undefined, "Commands"));
  console.log();
  printTable({
    headers: ["Command", "Description"],
    rows: [
      ...Object.entries(COMMANDS).map(([cmd, { desc }]) => [cmd, desc]),
      ["/quit", "Exit playground"],
    ],
  });
  console.log();
  console.log(hr("single", undefined, "Examples"));
  console.log(`  ${theme.dim("Type natural commands — they run on the device instantly")}`);
  console.log();

  const examples: Array<{ category: string; lines: string[] }> = [
    {
      category: "Apps",
      lines: [
        "open YouTube",
        "launch Settings app",
      ],
    },
    {
      category: "Tap & Navigate",
      lines: [
        "tap on Login",
        "click Search button",
        "select English",
        "navigate to Settings screen",
      ],
    },
    {
      category: "Type & Search",
      lines: [
        'type "hello world"',
        'type "john" in Username field',
        "search for appium 3.0",
        "press enter",
      ],
    },
    {
      category: "Scroll & Swipe",
      lines: [
        "scroll down",
        "swipe left",
        'scroll down 2 times until "Krishna" is visible',
        'scroll up to find "Notifications"',
      ],
    },
    {
      category: "Assert (recorded as a pass/fail step in your flow)",
      lines: [
        'assert "Welcome" is visible',
        'verify "Login" is displayed',
        "verify bell icon is present",
        "check red dot in the map",
      ],
    },
    {
      category: "Ask (inspect the screen — not recorded)",
      lines: [
        "Is there a bell icon on screen?",
        "What text is shown in the header?",
        "Is the map loaded?",
        "How many items are in the list?",
      ],
    },
    {
      category: "Device Controls",
      lines: [
        "go back",
        "go home",
        "wait 3 s",
        "toggle WiFi",
        "close popup",
      ],
    },
    {
      category: "Flow",
      lines: [
        "done",
        "done: login flow finished",
      ],
    },
  ];

  for (const section of examples) {
    // Split "Title (hint)" into colored title + dimmed hint
    const hintMatch = section.category.match(/^(.+?)(\s*\(.+\))$/);
    if (hintMatch) {
      console.log(`  ${theme.step.bold(hintMatch[1])}${theme.dim(hintMatch[2])}`);
    } else {
      console.log(`  ${theme.step.bold(section.category)}`);
    }
    for (const line of section.lines) {
      console.log(`    ${theme.info("›")} ${line}`);
    }
    console.log();
  }
}

// ─── Header ─────────────────────────────────────────────

function printPlaygroundHeader(): void {
  const content = [
    appGradient("Execute commands live & export as YAML"),
    "",
    `${theme.dim("Commands run on device immediately.")}`,
    `${theme.dim("Use")} ${theme.info("/yaml")} ${theme.dim("to preview and")} ${theme.info("/export")} ${theme.dim("to save.")}`,
    `${theme.dim("Type")} ${theme.info("/help")} ${theme.dim("for all commands.")}`,
  ].join("\n");

  console.log();
  printBox(content, { title: "AppClaw Playground", titleAlignment: "left" });
  console.log();
}

// ─── Prompt ─────────────────────────────────────────────

function getPrompt(): string {
  return `\n  ${chalk.hex("#7C6FFF").bold("›")} `;
}

// ─── Device connection ──────────────────────────────────

async function connectToDevice(): Promise<boolean> {
  const config = loadConfig();

  try {
    ui.startSpinner(`Connecting to appium-mcp (${config.MCP_TRANSPORT})…`);
    const mcpClient = await createMCPClient({
      transport: config.MCP_TRANSPORT,
      host: config.MCP_HOST,
      port: config.MCP_PORT,
    });
    state.mcp = mcpClient;
    ui.stopSpinner();
    ui.printSetupOk("Connected to appium-mcp");

    // Create Appium session
    ui.startSpinner("Creating Appium session…");
    const sessionResult = await mcpClient.callTool("create_session", androidCreateSessionArgs(config));
    const resultText = extractText(sessionResult);
    if (resultText.toLowerCase().includes("error") || resultText.toLowerCase().includes("failed")) {
      throw new Error(resultText);
    }
    ui.stopSpinner();
    ui.printSetupOk("Appium session created");

    // Initialize app resolver for "open X app" commands
    ui.startSpinner("Loading installed apps…");
    const appResolver = new AppResolver();
    await appResolver.initialize(mcpClient);
    state.appResolver = appResolver;
    ui.stopSpinner();
    ui.printSetupOk("App resolver ready");

    const readyContent = [
      `${theme.dim("Type commands to execute on device.")}`,
      "",
      `${theme.dim("Examples:")}`,
      `  ${theme.white("open youtube app")}`,
      `  ${theme.white("click on Search")}`,
      `  ${theme.white('type "hello"')}`,
    ].join("\n");
    console.log();
    printBox(readyContent, {
      title: "Device connected",
      titleAlignment: "left",
      borderColor: "#22C55E",
      padding: { left: 2, right: 2, top: 1, bottom: 1 },
    });
    console.log();

    return true;
  } catch (err: any) {
    ui.stopSpinner();
    ui.printError(`Failed to connect: ${err?.message ?? err}`);
    ui.printInfo("Make sure Appium server is running and a device/emulator is connected.");
    console.log();
    return false;
  }
}

// ─── Main REPL ──────────────────────────────────────────

export async function runPlayground(): Promise<void> {
  printPlaygroundHeader();

  // Connect to device first
  const connected = await connectToDevice();
  if (!connected) {
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let processing = false;

  function prompt(): void {
    rl.setPrompt(getPrompt());
    rl.prompt();
  }

  prompt();

  rl.on("line", async (input: string) => {
    const line = input.trim();

    if (!line) {
      prompt();
      return;
    }

    // Prevent overlapping commands
    if (processing) {
      console.log(`  ${theme.dim("Please wait for the current command to finish…")}`);
      return;
    }

    // Quit
    if (line === "/quit" || line === "/exit" || line === "/q") {
      if (state.steps.length > 0) {
        console.log();
        console.log(`  ${theme.warn("!")} ${state.steps.length} step${state.steps.length === 1 ? "" : "s"} not exported.`);
        console.log(`  ${theme.dim("Use")} ${theme.info("/export <file>")} ${theme.dim("to save, or type")} ${theme.info("/quit")} ${theme.dim("again to discard.")}`);
        console.log();
        rl.once("line", async (confirm: string) => {
          const c = confirm.trim();
          if (c === "/quit" || c === "/exit" || c === "/q" || c === "y" || c === "yes") {
            await cleanup();
            rl.close();
            return;
          }
          await processLine(c);
          prompt();
        });
        prompt();
        return;
      }
      await cleanup();
      rl.close();
      return;
    }

    processing = true;
    await processLine(line);
    processing = false;
    prompt();
  });

  rl.on("close", () => {
    console.log(`\n  ${theme.dim("Goodbye!")}\n`);
  });

  return new Promise((resolve) => {
    rl.on("close", resolve);
  });
}

async function cleanup(): Promise<void> {
  if (state.mcp) {
    try {
      await state.mcp.close();
    } catch { /* ignore */ }
  }
}

// ─── Screen queries (via vision getInfo) ─────────────

async function handleGetInfo(query: string): Promise<void> {
  if (!state.mcp) {
    console.log(`  ${theme.error("✗")} Not connected to device`);
    return;
  }

  try {
    ui.startSpinner("Analyzing screen", query);
    const { screenshot } = await import("../mcp/tools.js");
    const imageBase64 = await screenshot(state.mcp);
    if (!imageBase64) {
      ui.stopSpinner();
      console.log(`  ${theme.error("✗")} Failed to capture screenshot`);
      return;
    }

    const { getStarkVisionApiKey, getStarkVisionModel } = await import("../vision/locate-enabled.js");
    const apiKey = getStarkVisionApiKey();
    if (!apiKey) {
      ui.stopSpinner();
      console.log(`  ${theme.error("✗")} getInfo requires STARK_VISION_API_KEY or GEMINI_API_KEY`);
      return;
    }

    const { default: starkVision } = await import("df-vision");
    const { StarkVisionClient } = starkVision;
    const client = new StarkVisionClient({ apiKey, model: getStarkVisionModel(), disableThinking: true });
    const response = await client.getElementInfo(imageBase64, query, true);

    let answer: string;
    let explanation: string | undefined;
    try {
      const parsed = JSON.parse(response.replace(/(^```json\s*|```\s*$)/g, "").trim());
      answer = parsed.answer || response;
      explanation = parsed.explanation;
    } catch {
      answer = response;
    }

    ui.stopSpinner();
    console.log();
    const ansContent = explanation ? `${answer}\n\n${theme.dim(explanation)}` : answer;
    printPanel({ title: "Answer", content: ansContent });
    console.log();
  } catch (err: any) {
    ui.stopSpinner();
    console.log(`  ${theme.error("✗")} Failed to get info: ${theme.error(err?.message ?? String(err))}`);
  }
}

async function processLine(line: string): Promise<void> {
  // Slash commands
  if (line.startsWith("/")) {
    const spaceIdx = line.indexOf(" ");
    const cmd = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const arg = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);

    const handler = COMMANDS[cmd];
    if (handler) {
      await handler.run(arg);
      return;
    }
    console.log(`  ${theme.error("✗")} Unknown command: ${theme.dim(cmd)} — type ${theme.info("/help")}`);
    return;
  }

  // ── Hybrid single-call path (vision mode) ──
  // In vision mode: screenshot + instruction → one LLM call → classify + locate → execute.
  // Falls back to two-call path (classifyInstruction → executeStep) for non-visual instructions.
  if (state.mcp && Config.AGENT_MODE === "vision") {
    try {
      ui.startSpinner("Executing", line);
      const vResult = await visionExecute(state.mcp, line);
      ui.stopSpinner();

      if (vResult) {
        if (vResult.isGetInfo) {
          const ans = vResult.getInfoAnswer || vResult.result.message;
          const ansBody = vResult.getInfoExplanation ? `${ans}\n\n${theme.dim(vResult.getInfoExplanation)}` : ans;
          console.log();
          printPanel({ title: "Answer", content: ansBody });
          console.log();
          return;
        }

        if (vResult.result.message === "__needs_executeStep__") {
          const stepNum = state.steps.length + 1;
          ui.startSpinner(`[${stepNum}] ${vResult.step.kind}`, spinnerDetail(vResult.step));
          const execResult = await runStepOnDevice(vResult.step);
          ui.stopSpinner();
          if (execResult.success) {
            state.steps.push(vResult.step);
            printStepSuccess(stepNum, vResult.step, execResult.message);
          } else {
            printStepFail(stepNum, vResult.step, execResult.message);
          }
          return;
        }

        const stepNum = state.steps.length + 1;
        if (vResult.result.success) {
          state.steps.push(vResult.step);
          printStepSuccess(stepNum, vResult.step, vResult.result.message);
        } else {
          printStepFail(stepNum, vResult.step, vResult.result.message);
          console.log(`    ${theme.dim("Step not recorded. Fix and try again.")}`);
        }
        return;
      }
    } catch (err: any) {
      ui.stopSpinner();
      console.log(`  ${theme.dim("Vision shortcut failed, falling back…")}`);
    }
  }

  // ── Two-call fallback: classify via LLM → execute via step runner ──
  let parsed: FlowStep;
  try {
    ui.startSpinner("Classifying", line);
    parsed = await classifyInstruction(line);
    ui.stopSpinner();
  } catch (err: any) {
    ui.stopSpinner();
    console.log(`  ${theme.error("✗")} Could not classify: ${theme.dim(err?.message ?? String(err))}`);
    console.log(`    ${theme.dim("Type")} ${theme.info("/help")} ${theme.dim("to see supported patterns")}`);
    return;
  }

  if (parsed.kind === "getInfo") {
    await handleGetInfo(parsed.query);
    return;
  }

  const stepNum = state.steps.length + 1;

  if (parsed.kind === "done") {
    state.steps.push(parsed);
    printStepSuccess(stepNum, parsed, "recorded");
    return;
  }

  // Execute on device
  ui.startSpinner(`[${stepNum}] ${parsed.kind}`, spinnerDetail(parsed));

  try {
    const result = await runStepOnDevice(parsed);
    ui.stopSpinner();

    if (result.success) {
      state.steps.push(parsed);
      printStepSuccess(stepNum, parsed, result.message);
    } else {
      printStepFail(stepNum, parsed, result.message);
      console.log(`    ${theme.dim("Step not recorded. Fix and try again.")}`);
    }
  } catch (err: any) {
    ui.stopSpinner();
    printStepFail(stepNum, parsed, err?.message ?? String(err));
    console.log(`    ${theme.dim("Step not recorded. Fix and try again.")}`);
  }
}
