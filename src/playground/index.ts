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

import { loadConfig } from "../config.js";
import { createMCPClient } from "../mcp/client.js";
import { extractText, getPageSource } from "../mcp/tools.js";
import { androidCreateSessionArgs } from "../mcp/session-caps.js";
import { AppResolver } from "../agent/app-resolver.js";
import { tryParseNaturalFlowLine } from "../flow/natural-line.js";
import type { FlowStep, FlowMeta } from "../flow/types.js";
import type { MCPClient } from "../mcp/types.js";
import { theme } from "../ui/terminal.js";
import * as ui from "../ui/terminal.js";
import { detectPlatform } from "../perception/screen.js";
import { parseAndroidPageSource } from "../perception/android-parser.js";
import { parseIOSPageSource } from "../perception/ios-parser.js";

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

function stepKindLabel(step: FlowStep): string {
  switch (step.kind) {
    case "launchApp":    return `${theme.step("launch")} ${theme.dim("app")}`;
    case "openApp":      return `${theme.step("open")}   ${theme.white(step.query)}`;
    case "tap":          return `${theme.step("tap")}    ${theme.white(`"${step.label}"`)}`;
    case "type":         return `${theme.step("type")}   ${theme.white(`"${step.text}"`)}${step.target ? ` ${theme.dim("in")} ${theme.white(step.target)}` : ""}`;
    case "swipe":        return `${theme.step("swipe")}  ${theme.white(step.direction)}`;
    case "wait":         return `${theme.step("wait")}   ${theme.white(`${step.seconds}s`)}`;
    case "enter":        return theme.step("enter");
    case "back":         return theme.step("back");
    case "home":         return theme.step("home");
    case "assert":       return `${theme.step("assert")} ${theme.white(`"${step.text}"`)}`;
    case "scrollAssert": return `${theme.step("scrollAssert")} ${theme.white(`"${step.text}"`)} ${theme.dim(`${step.direction} ×${step.maxScrolls}`)}`;
    case "done":         return `${chalk.green("done")}   ${step.message ? theme.dim(step.message) : ""}`;
  }
}

function stepToDisplay(step: FlowStep, index: number): string {
  const num = theme.dim(`${(index + 1).toString().padStart(2)}.`);
  return `${num} ${stepKindLabel(step)}`;
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

  console.log();
  const metaLine = state.meta.name
    ? `${theme.brand.bold(state.meta.name)}${state.meta.appId ? theme.dim(` (${state.meta.appId})`) : ""}`
    : state.meta.appId
      ? theme.dim(state.meta.appId)
      : "";
  if (metaLine) {
    console.log(`  ${theme.dim("┌")} ${metaLine}`);
  } else {
    console.log(`  ${theme.dim("┌ Flow")}`);
  }
  console.log(`  ${theme.dim("│")}`);
  for (let i = 0; i < state.steps.length; i++) {
    console.log(`  ${theme.dim("│")}  ${stepToDisplay(state.steps[i], i)}`);
  }
  console.log(`  ${theme.dim("│")}`);
  console.log(`  ${theme.dim(`└ ${state.steps.length} step${state.steps.length === 1 ? "" : "s"}`)}`);
  console.log();
}

// ─── Step execution ─────────────────────────────────────

async function runStepOnDevice(step: FlowStep): Promise<{ success: boolean; message: string }> {
  if (!state.mcp) {
    return { success: false, message: "Not connected to device" };
  }

  const tapPoll: FlowTapPollOptions = { maxAttempts: 20, intervalMs: 300 };
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
      console.log();
      console.log(`  ${theme.brand.bold("YAML Preview")}`);
      console.log(`  ${theme.dim("─".repeat(40))}`);
      const yamlStr = buildYamlString();
      for (const line of yamlStr.split("\n")) {
        console.log(`  ${theme.white(line)}`);
      }
      console.log(`  ${theme.dim("─".repeat(40))}`);
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
      console.log();
      console.log(`  ${theme.success("✓")} ${theme.success.bold("Exported")} ${state.steps.length} steps`);
      console.log(`    ${theme.dim("→")} ${theme.muted(filepath)}`);
      console.log(`    ${theme.dim("Run with:")} ${theme.info(`appclaw --flow ${path.relative(process.cwd(), filepath)}`)}`);
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
  console.log(`  ${theme.brand.bold("Commands")}`);
  console.log();
  for (const [cmd, { desc }] of Object.entries(COMMANDS)) {
    console.log(`  ${theme.info(cmd.padEnd(12))} ${theme.dim(desc)}`);
  }
  console.log(`  ${theme.info("/quit".padEnd(12))} ${theme.dim("Exit playground")}`);
  console.log();
  console.log(`  ${theme.brand.bold("Step Patterns")} ${theme.dim("— type these directly to execute on device")}`);
  console.log();
  console.log(`  ${theme.step("open / launch")}     ${theme.dim("open YouTube app, launch Settings")}`);
  console.log(`  ${theme.step("tap / click")}       ${theme.dim("tap on Search, click Login button")}`);
  console.log(`  ${theme.step("select / choose")}   ${theme.dim("select English, choose Dark mode")}`);
  console.log(`  ${theme.step("type")}              ${theme.dim('type "hello world", type hello')}`);
  console.log(`  ${theme.step("search for")}        ${theme.dim("search for appium 3.0, find settings")}`);
  console.log(`  ${theme.step("enter / submit")}    ${theme.dim("press enter, submit, confirm")}`);
  console.log(`  ${theme.step("swipe / scroll")}    ${theme.dim("swipe up, scroll down")}`);
  console.log(`  ${theme.step("wait")}              ${theme.dim("wait 3 s, wait, pause a moment")}`);
  console.log(`  ${theme.step("back / home")}       ${theme.dim("go back, navigate back, go home")}`);
  console.log(`  ${theme.step("navigate to")}       ${theme.dim("navigate to Settings screen")}`);
  console.log(`  ${theme.step("toggle / enable")}   ${theme.dim("toggle WiFi, turn on Bluetooth")}`);
  console.log(`  ${theme.step("close / dismiss")}   ${theme.dim("close popup, dismiss dialog")}`);
  console.log(`  ${theme.step("assert / verify")}   ${theme.dim('assert "Connected" is visible')}`);
  console.log(`  ${theme.step("scroll until")}      ${theme.dim('scroll down until "Settings" is visible')}`);
  console.log(`  ${theme.step("done")}              ${theme.dim("done: marks flow end (not executed)")}`);
  console.log();
}

// ─── Header ─────────────────────────────────────────────

function printPlaygroundHeader(): void {
  console.log();
  console.log(`  ${theme.dim("╭──────────────────────────────────────────────────────╮")}`);
  console.log(`  ${theme.dim("│")}                                                      ${theme.dim("│")}`);
  console.log(`  ${theme.dim("│")}   ${theme.brand.bold("AppClaw Playground")}                                 ${theme.dim("│")}`);
  console.log(`  ${theme.dim("│")}   ${theme.muted("Execute commands live & export as YAML")}            ${theme.dim("│")}`);
  console.log(`  ${theme.dim("│")}                                                      ${theme.dim("│")}`);
  console.log(`  ${theme.dim("│")}   ${theme.dim("Commands run on device immediately.")}                 ${theme.dim("│")}`);
  console.log(`  ${theme.dim("│")}   ${theme.dim("Use")} ${theme.info("/yaml")} ${theme.dim("to preview and")} ${theme.info("/export")} ${theme.dim("to save.")}          ${theme.dim("│")}`);
  console.log(`  ${theme.dim("│")}   ${theme.dim("Type")} ${theme.info("/help")} ${theme.dim("for all commands.")}                       ${theme.dim("│")}`);
  console.log(`  ${theme.dim("│")}                                                      ${theme.dim("│")}`);
  console.log(`  ${theme.dim("╰──────────────────────────────────────────────────────╯")}`);
  console.log();
}

// ─── Prompt ─────────────────────────────────────────────

function getPrompt(): string {
  const count = state.steps.length;
  if (count === 0) {
    return `  ${chalk.hex("#7C6FFF")("▸")} `;
  }
  return `  ${theme.dim(`[${count}]`)} ${chalk.hex("#7C6FFF")("▸")} `;
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

    console.log();
    console.log(`  ${theme.success.bold("Device connected!")} ${theme.dim("Type commands to execute on device.")}`);
    console.log(`  ${theme.dim("Examples:")} ${theme.white("open youtube app")}${theme.dim(",")} ${theme.white("click on Search")}${theme.dim(",")} ${theme.white('type "hello"')}`);
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

// ─── Screen queries ──────────────────────────────────

const SCREEN_QUERY_RE = /^(?:tell\s+me|what(?:'s|\s+is|\s+are)|how\s+many|show\s+me|describe|list|what\s+do\s+i\s+see|what\s+can\s+i\s+see|what\s+(?:texts?|elements?|options?|items?|buttons?)\s+(?:are|is))/i;

function isScreenQuery(line: string): boolean {
  return SCREEN_QUERY_RE.test(line.trim());
}

async function handleScreenQuery(query: string): Promise<void> {
  if (!state.mcp) {
    console.log(`  ${theme.error("✗")} Not connected to device`);
    return;
  }

  try {
    console.log(`  ${theme.dim("Reading screen…")}`);
    const pageSource = await getPageSource(state.mcp);
    const platform = detectPlatform(pageSource);
    const elements = platform === "android"
      ? parseAndroidPageSource(pageSource)
      : parseIOSPageSource(pageSource);

    const visibleTexts = elements
      .map(el => el.text)
      .filter(t => t.length > 0);
    const uniqueTexts = [...new Set(visibleTexts)];

    if (uniqueTexts.length === 0) {
      console.log(`  ${theme.dim("No text elements visible on screen.")}`);
      return;
    }

    console.log();
    console.log(`  ${theme.brand.bold("Screen")} ${theme.dim(`(${uniqueTexts.length} visible texts)`)}`);
    console.log(`  ${theme.dim("─".repeat(40))}`);
    for (let i = 0; i < uniqueTexts.length; i++) {
      console.log(`  ${theme.dim(`${(i + 1).toString().padStart(3)}.`)} ${theme.white(uniqueTexts[i])}`);
    }
    console.log(`  ${theme.dim("─".repeat(40))}`);
    console.log();
  } catch (err: any) {
    console.log(`  ${theme.error("✗")} Failed to read screen: ${theme.error(err?.message ?? String(err))}`);
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

  // Screen query — user is asking a question about the screen (not a step)
  if (isScreenQuery(line)) {
    await handleScreenQuery(line);
    return;
  }

  // Parse as natural language step
  const parsed = tryParseNaturalFlowLine(line);
  if (!parsed) {
    console.log(`  ${theme.error("✗")} Could not parse: ${theme.dim(line)}`);
    console.log(`    ${theme.dim("Type")} ${theme.info("/help")} ${theme.dim("to see supported patterns")}`);
    return;
  }

  const stepNum = state.steps.length + 1;

  // "done" steps are just recorded, not executed
  if (parsed.kind === "done") {
    state.steps.push(parsed);
    console.log(`  ${theme.dim(`[${stepNum}]`)} ${chalk.green("done")} ${parsed.message ? theme.dim(parsed.message) : ""} ${theme.success("✓ recorded")}`);
    return;
  }

  // Execute on device
  console.log(`  ${theme.dim(`[${stepNum}]`)} ${stepKindLabel(parsed)} ${theme.dim("…")}`);

  try {
    const result = await runStepOnDevice(parsed);

    if (result.success) {
      state.steps.push(parsed);
      console.log(`  ${theme.dim(`[${stepNum}]`)} ${stepKindLabel(parsed)} ${theme.success("✓")} ${theme.dim(result.message)}`);
    } else {
      console.log(`  ${theme.dim(`[${stepNum}]`)} ${stepKindLabel(parsed)} ${theme.error("✗")} ${theme.error(result.message)}`);
      console.log(`    ${theme.dim("Step not recorded. Fix and try again.")}`);
    }
  } catch (err: any) {
    console.log(`  ${theme.dim(`[${stepNum}]`)} ${stepKindLabel(parsed)} ${theme.error("✗")} ${theme.error(err?.message ?? String(err))}`);
    console.log(`    ${theme.dim("Step not recorded. Fix and try again.")}`);
  }
}
