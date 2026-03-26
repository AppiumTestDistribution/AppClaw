/**
 * Terminal UI — styled console output for AppClaw.
 *
 * Minimal chrome, clear hierarchy, compact output.
 * Inspired by Vercel CLI / pnpm / turbo aesthetics.
 */

import chalk from "chalk";
import cliSpinners from "cli-spinners";
import path from "node:path";
import readline from "node:readline";

import { Config } from "../config.js";

// ─── Theme ───────────────────────────────────────────────

const theme = {
  brand:    chalk.hex("#7C6FFF"),
  success:  chalk.green,
  error:    chalk.red,
  warn:     chalk.yellow,
  dim:      chalk.dim,
  bold:     chalk.bold,
  muted:    chalk.gray,
  info:     chalk.cyan,
  white:    chalk.white,
  step:     chalk.hex("#6CB6FF"),
  label:    chalk.hex("#9CA3AF"),
  // Pill badges (inverse video)
  badgeSkip:    chalk.bgGreen.black,
  badgeAdapt:   chalk.bgYellow.black,
  badgeProceed: chalk.bgCyan.black,
};

// ─── Helpers ─────────────────────────────────────────────

/** Section label — bold colored text, no box drawing */
function section(label: string): string {
  return `  ${theme.brand.bold(label)}`;
}

/** Strip ANSI escape codes to get visible string length */
function visLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "").length;
}

/** Word-wrap text to maxWidth, returning indented continuation lines */
function wrapText(text: string, maxWidth: number, indent: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : " ".repeat(indent) + l));
}

// ─── Spinner ─────────────────────────────────────────────

const SPINNER = cliSpinners.dots;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;
let spinnerLineActive = false;
let spinnerPrimary = "";
let spinnerDetail: string | undefined;

function paintSpinnerLine(frame: number, overwrite: boolean): void {
  const sym = theme.brand(SPINNER.frames[frame % SPINNER.frames.length]);
  const line = spinnerDetail
    ? `  ${sym} ${theme.step.bold(spinnerPrimary)} ${theme.dim(`(${spinnerDetail})`)}`
    : `  ${sym} ${theme.dim(spinnerPrimary)}`;
  if (overwrite) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  process.stdout.write(line);
}

export function formatAgentThinkingDetail(modelName: string): string {
  const mode = Config.AGENT_MODE === "vision" ? "vision" : "dom";
  const think = Config.LLM_THINKING === "on" ? "thinking on" : "thinking off";
  const m = modelName.trim() || "model";
  const short = m.length > 40 ? `${m.slice(0, 37)}…` : m;
  return `${mode} · ${think} · ${short}`;
}

export function printAgentBullet(message: string): void {
  console.log(`  ${theme.muted("○")} ${theme.dim(message)}`);
}

/** Update spinner text without restarting the animation */
export function updateSpinner(message?: string, detail?: string): void {
  if (!spinnerLineActive) return;
  if (message !== undefined) spinnerPrimary = message;
  if (detail !== undefined) spinnerDetail = detail;
  paintSpinnerLine(spinnerFrame, true);
}

export function startSpinner(message: string, detail?: string): void {
  stopSpinner();
  spinnerFrame = 0;
  spinnerLineActive = true;
  spinnerPrimary = message;
  spinnerDetail = detail;

  // Hide cursor, paint initial frame, then animate
  process.stdout.write("\x1B[?25l"); // hide cursor
  paintSpinnerLine(spinnerFrame, false);
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER.frames.length;
    paintSpinnerLine(spinnerFrame, true);
  }, SPINNER.interval);
}

export function stopSpinner(finalMessage?: string): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  if (spinnerLineActive) {
    spinnerLineActive = false;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write("\x1B[?25h"); // show cursor
    if (finalMessage) {
      process.stdout.write(finalMessage + "\n");
    }
  }
}

// ─── Streaming reasoning display ─────────────────────────

const STREAM_MAX_LINES = 5;     // Max visible lines during live streaming
const STREAM_LINE_WIDTH = 72;   // Max chars per line before wrapping
let streamLineCount = 0;        // Lines currently printed below the header
let streamBuffer = "";          // Accumulated reasoning text
let streamActive = false;
let streamLabel = "";

/**
 * Strip tool-call-like text from reasoning output.
 * The model often appends `find_and_click(...)` or `done` at the end —
 * we already show the action on the step line, so remove the noise.
 */
function cleanReasoningText(text: string): string {
  return text
    // Remove tool call lines: find_and_click(...), find_and_type(...), done, launch_app(...)
    .replace(/\n?\s*(find_and_click|find_and_type|launch_app|go_back|go_home|done|ask_user)\s*(\([\s\S]*?\))?\s*$/i, "")
    .trim();
}

/**
 * Begin streaming reasoning text below the spinner.
 */
export function startStreaming(label: string = "Thinking"): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  spinnerLineActive = false;

  streamActive = true;
  streamBuffer = "";
  streamLineCount = 0;
  streamLabel = label;

  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  // Header with colored accent bar
  process.stdout.write(`  ${theme.brand("┃")} ${theme.step(label)}\n`);
}

/**
 * Append a text chunk to the streaming display.
 */
export function streamChunk(text: string): void {
  if (!streamActive) return;
  streamBuffer += text;

  const allLines = wrapStreamText(streamBuffer, STREAM_LINE_WIDTH);
  const visible = allLines.slice(-STREAM_MAX_LINES);

  eraseStreamLines();

  for (const line of visible) {
    process.stdout.write(`  ${theme.brand("┃")} ${theme.muted(line)}\n`);
  }
  streamLineCount = visible.length;
}

/**
 * End streaming — re-render as a clean, final block.
 */
export function stopStreaming(): void {
  if (!streamActive) return;
  streamActive = false;

  eraseStreamLines();
  process.stdout.write("\x1B[1A");
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);

  const cleaned = cleanReasoningText(streamBuffer);
  if (cleaned) {
    const allLines = wrapStreamText(cleaned, STREAM_LINE_WIDTH);
    process.stdout.write(`  ${theme.dim("┃")} ${theme.dim(streamLabel)}\n`);
    for (const line of allLines) {
      process.stdout.write(`  ${theme.dim("┃")} ${theme.muted(line)}\n`);
    }
  }

  streamBuffer = "";
  streamLineCount = 0;
  process.stdout.write("\x1B[?25h");
}

function eraseStreamLines(): void {
  for (let i = 0; i < streamLineCount; i++) {
    process.stdout.write("\x1B[1A");
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

/**
 * Print reasoning text as a static block (fallback when streaming wasn't used).
 */
export function printReasoning(text: string): void {
  const cleaned = cleanReasoningText(text);
  if (!cleaned) return;

  const allLines = wrapStreamText(cleaned, STREAM_LINE_WIDTH);
  console.log(`  ${theme.dim("┃")} ${theme.dim("Reasoning")}`);
  for (const line of allLines) {
    console.log(`  ${theme.dim("┃")} ${theme.muted(line)}`);
  }
}

/** Word-wrap text for the streaming display */
function wrapStreamText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    const words = para.split(" ").filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (line && line.length + word.length + 1 > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// ─── Header (ASCII art box) ──────────────────────────────

const LOGO_LINES = [
  "▄▀█ █▀█ █▀█ █▀▀ █   ▄▀█ █ █ █",
  "█▀█ █▀▀ █▀▀ █▄▄ █▄▄ █▀█ ▀▄▀▄▀",
];

const BOX_W = 56;
const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

function bxLine(content: string, contentVisLen: number): string {
  const pad = BOX_W - contentVisLen;
  return `  ${theme.dim(BOX.v)} ${content}${" ".repeat(Math.max(pad, 0))}${theme.dim(BOX.v)}`;
}

function bxAuto(styled: string): string {
  return bxLine(styled, visLen(styled));
}

function boxTop(label?: string): string {
  if (label) {
    const inner = BOX_W - label.length - 2;
    return `  ${theme.dim(`${BOX.tl}${BOX.h}`)} ${theme.brand.bold(label)} ${theme.dim(BOX.h.repeat(Math.max(inner, 2)) + BOX.tr)}`;
  }
  return `  ${theme.dim(BOX.tl + BOX.h.repeat(BOX_W + 2) + BOX.tr)}`;
}

function boxBottom(): string {
  return `  ${theme.dim(BOX.bl + BOX.h.repeat(BOX_W + 2) + BOX.br)}`;
}

function boxEmpty(): string {
  return bxLine("", 0);
}

export function printHeader(version: string = "0.1.0"): void {
  const vTag = `v${version}`;
  console.log();
  console.log(boxTop("AppClaw"));
  console.log(boxEmpty());
  for (const line of LOGO_LINES) {
    console.log(bxAuto(`   ${theme.brand(line)}`));
  }
  const vPad = BOX_W - vTag.length - 1;
  console.log(bxAuto(`${" ".repeat(vPad)}${theme.dim(vTag)} `));
  console.log(boxEmpty());
  console.log(bxAuto(`   ${theme.muted("AI Mobile Testing Agent")}`));
  console.log(boxEmpty());
  console.log(boxBottom());
  console.log();
}

export function printInteractiveHeader(): void {
  console.log();
  console.log(boxTop("AppClaw"));
  console.log(boxEmpty());
  for (const line of LOGO_LINES) {
    console.log(bxAuto(`   ${theme.brand(line)}`));
  }
  console.log(boxEmpty());
  console.log(bxAuto(`   ${theme.muted("AI Mobile Testing Agent")}`));
  console.log(boxEmpty());
  console.log(`  ${theme.dim("├" + BOX.h.repeat(BOX_W + 2) + "┤")}`);
  console.log(boxEmpty());
  console.log(bxAuto(`   ${theme.info("--record")}   ${theme.muted("Record actions for replay")}`));
  console.log(bxAuto(`   ${theme.info("--replay")}   ${theme.muted("Replay a recorded flow")}`));
  console.log(bxAuto(`   ${theme.info("--flow")}     ${theme.muted("Run steps from a YAML file")}`));
  console.log(bxAuto(`   ${theme.info("--playground")} ${theme.muted("Build YAML flows interactively")}`));
  console.log(bxAuto(`   ${theme.info("--plan")}     ${theme.muted("Decompose complex goals")}`));
  console.log(bxAuto(`   ${theme.info("--explore")}  ${theme.muted("Generate flows from a PRD")}`));
  console.log(boxEmpty());
  console.log(boxBottom());
  console.log();
}

// ─── Config ──────────────────────────────────────────────

export function printConfig(entries: Array<[string, string]>): void {
  for (const [label, value] of entries) {
    console.log(`  ${theme.label(label.padEnd(14))} ${theme.white(value)}`);
  }
}

export function printSetupOk(message: string): void {
  console.log(`  ${theme.success("✓")} ${message}`);
}

export function printSetupError(message: string, hint?: string): void {
  console.log(`  ${theme.error("✗")} ${message}`);
  if (hint) console.log(`    ${theme.dim(hint)}`);
}

// ─── Goal ────────────────────────────────────────────────

export function printGoalStart(goal: string, maxSteps: number): void {
  console.log();
  console.log(section("Goal"));
  const wrapped = wrapText(goal, 65, 2);
  for (const line of wrapped) {
    console.log(`  ${theme.bold(line)}`);
  }
  console.log(`  ${theme.dim(`max ${maxSteps} steps`)}`);
  console.log();
}

export function printStep(
  step: number,
  maxSteps: number,
  toolName: string,
  argsSummary: string
): void {
  const counter = theme.dim(`[${step}/${maxSteps}]`.padEnd(8));

  // Friendly display names for meta-tools
  if (toolName === "find_and_click") {
    // Extract vision description or selector from args
    const visionMatch = argsSummary.match(/vision="([^"]+)"/);
    const selectorMatch = argsSummary.match(/selector="([^"]+)"/);
    const target = visionMatch?.[1] || selectorMatch?.[1] || argsSummary;
    const short = target.length > 65 ? target.slice(0, 62) + "…" : target;
    console.log(`  ${counter}${theme.step("tap")} ${theme.muted(short)}`);
    return;
  }
  if (toolName === "find_and_type") {
    const visionMatch = argsSummary.match(/vision="([^"]+)"/);
    const selectorMatch = argsSummary.match(/selector="([^"]+)"/);
    const textMatch = argsSummary.match(/text="([^"]+)"/);
    const target = visionMatch?.[1] || selectorMatch?.[1] || "field";
    const text = textMatch?.[1] || "";
    const short = target.length > 40 ? target.slice(0, 37) + "…" : target;
    console.log(`  ${counter}${theme.step("type")} ${theme.muted(`"${text}"`)} ${theme.dim(`→ ${short}`)}`);
    return;
  }
  if (toolName === "done") {
    const reasonMatch = argsSummary.match(/reason="([^"]+)"/);
    const reason = reasonMatch?.[1] || argsSummary.replace(/^reason=/, "");
    const short = reason.length > 65 ? reason.slice(0, 62) + "…" : reason;
    console.log(`  ${counter}${theme.success("done")} ${theme.dim(short)}`);
    return;
  }

  const tool = theme.step(toolName);
  const args = argsSummary ? ` ${theme.muted(argsSummary)}` : "";
  console.log(`  ${counter}${tool}${args}`);
}

export function printStepDetail(message: string): void {
  console.log(`  ${" ".repeat(8)}${theme.dim("→")} ${theme.dim(message)}`);
}

export function printStepError(message: string): void {
  console.log(`  ${" ".repeat(8)}${theme.error("✗")} ${theme.error(message)}`);
}

export function printGoalSuccess(steps: number, reason: string): void {
  console.log();
  console.log(`  ${theme.success("✓")} ${theme.success.bold("Completed")} ${theme.dim(`in ${steps} steps`)}`);
  console.log(`    ${theme.dim(reason)}`);
  console.log(`  ${theme.dim("─".repeat(50))}`);
}

export function printGoalFailed(reason: string): void {
  console.log();
  console.log(`  ${theme.error("✗")} ${theme.error.bold("Failed")} ${theme.dim("—")} ${theme.dim(reason)}`);
}

// ─── Plan ────────────────────────────────────────────────

export function printPlanStart(): void {
  startSpinner("Decomposing goal…", "planner");
}

export function printPlan(subGoals: Array<{ goal: string }>, reasoning: string): void {
  console.log();
  console.log(section("Plan"));
  for (let i = 0; i < subGoals.length; i++) {
    console.log(`  ${theme.dim(`${i + 1}.`)} ${subGoals[i].goal}`);
  }
  console.log();
  // Truncate reasoning to 2 lines max
  const lines = wrapText(reasoning, 72, 2);
  const shown = lines.slice(0, 2);
  for (const line of shown) {
    console.log(`  ${theme.dim(line)}`);
  }
  console.log();
}

/** Compact inline plan progress — shown before each sub-goal */
export function printPlanContext(
  overallGoal: string,
  _currentGoal: string,
  allGoals: Array<{ goal: string; status: string }>,
  currentIndex: number
): void {
  console.log();
  console.log(section("Progress"));
  console.log(`  ${theme.label("Goal:")} ${theme.white(overallGoal.length > 60 ? overallGoal.slice(0, 57) + "…" : overallGoal)}`);
  console.log();
  for (let i = 0; i < allGoals.length; i++) {
    const sg = allGoals[i];
    const num = `${i + 1}.`;
    if (sg.status === "completed") {
      console.log(`  ${theme.success("✓")} ${theme.dim(num)} ${theme.dim(sg.goal)}`);
    } else if (i === currentIndex) {
      console.log(`  ${theme.brand("▸")} ${theme.white(num)} ${theme.white.bold(sg.goal)}`);
    } else {
      console.log(`  ${theme.dim("○")} ${theme.dim(num)} ${theme.dim(sg.goal)}`);
    }
  }
  console.log();
}

export function printSubGoalHeader(
  index: number,
  total: number,
  goal: string,
  allGoals: Array<{ goal: string; status: string }>
): void {
  // Delegate to printPlanContext for consistency
  printPlanContext("", goal, allGoals, index);
}

export function printPlanSummary(
  subGoals: Array<{ goal: string; status: string; result?: string }>
): void {
  console.log();
  console.log(section("Summary"));
  const passed = subGoals.filter(sg => sg.status === "completed").length;
  console.log();
  for (let i = 0; i < subGoals.length; i++) {
    const sg = subGoals[i];
    const icon = sg.status === "completed" ? theme.success("✓") : theme.error("✗");
    const goalText = sg.goal.length > 50 ? sg.goal.slice(0, 47) + "…" : sg.goal;
    const result = sg.result
      ? theme.dim(sg.result.length > 50 ? sg.result.slice(0, 47) + "…" : sg.result)
      : "";
    console.log(`  ${icon} ${theme.dim(`${i + 1}.`)} ${theme.white(goalText)}`);
    if (result) console.log(`       ${result}`);
  }
  console.log();
  const allOk = passed === subGoals.length;
  const icon = allOk ? theme.success("✓") : theme.warn("!");
  const msg = allOk
    ? theme.success.bold(`${passed}/${subGoals.length} completed`)
    : theme.warn.bold(`${passed}/${subGoals.length} completed`);
  console.log(`  ${icon} ${msg}`);
  console.log();
}

// ─── Orchestrator badges ─────────────────────────────────

export function printOrchestratorSkip(subGoal: string, reason: string): void {
  const badge = theme.badgeSkip(" SKIP ");
  const goalShort = subGoal.length > 55 ? subGoal.slice(0, 52) + "…" : subGoal;
  console.log(`  ${badge} ${theme.dim(goalShort)}`);
  console.log(`    ${theme.dim(reason.length > 80 ? reason.slice(0, 77) + "…" : reason)}`);
}

export function printOrchestratorRewrite(original: string, rewritten: string): void {
  const badge = theme.badgeAdapt(" ADAPT ");
  const origShort = original.length > 50 ? original.slice(0, 47) + "…" : original;
  console.log(`  ${badge} ${theme.dim(origShort)}`);
  console.log(`    ${theme.brand("→")} ${theme.white.bold(rewritten.length > 70 ? rewritten.slice(0, 67) + "…" : rewritten)}`);
}

export function printOrchestratorProceed(subGoal: string): void {
  const badge = theme.badgeProceed(" NEXT ");
  console.log(`  ${badge} ${theme.white(subGoal)}`);
}

export function printScreenReadiness(issues: string[], suggestedAction?: string): void {
  console.log(`  ${theme.warn("⚠")} ${theme.warn("Screen not ready")}`);
  for (const issue of issues) {
    console.log(`    ${theme.dim("•")} ${theme.dim(issue)}`);
  }
  if (suggestedAction) {
    console.log(`    ${theme.brand("→")} ${theme.white(suggestedAction)}`);
  }
}

// ─── Replay / Flow ───────────────────────────────────────

export function printReplayHeader(filepath: string): void {
  console.log();
  console.log(`  ${theme.brand.bold("Replay")} ${theme.dim(filepath)}`);
}

export function printReplayGoal(goal: string, totalSteps: number): void {
  console.log(`  ${theme.bold(goal)} ${theme.dim(`(${totalSteps} steps)`)}`);
  console.log();
}

export function printReplayStep(
  step: number,
  total: number,
  toolName: string,
  adapted: boolean,
  success: boolean
): void {
  const counter = theme.dim(`[${step}/${total}]`.padEnd(8));
  const tool = theme.step(toolName);
  const badges: string[] = [];
  if (adapted) badges.push(theme.info(" adapted"));
  badges.push(success ? theme.success(" ok") : theme.error(" failed"));
  console.log(`  ${counter}${tool}${badges.join("")}`);
}

export function printYamlFlowHeader(filepath: string): void {
  console.log();
  console.log(`  ${theme.brand.bold("Flow")} ${theme.dim(filepath)}`);
}

export function printFlowStep(step: number, total: number, label: string, success: boolean): void {
  const counter = theme.dim(`[${step}/${total}]`.padEnd(8));
  const line = theme.step(label);
  const status = success ? theme.success(" ok") : theme.error(" failed");
  console.log(`  ${counter}${line}${status}`);
}

export function printReplayResult(
  passed: number,
  total: number,
  adapted: number
): void {
  console.log();
  const allPassed = passed === total;
  const icon = allPassed ? theme.success("✓") : theme.warn("!");
  const status = allPassed
    ? theme.success.bold("All steps passed")
    : theme.warn.bold(`${passed}/${total} passed`);
  const adaptedNote = adapted > 0 ? theme.dim(` (${adapted} adapted)`) : "";
  console.log(`  ${icon} ${status}${adaptedNote}`);
  console.log();
}

// ─── Status / misc ───────────────────────────────────────

export function printWarning(message: string): void {
  console.log(`  ${theme.warn("!")} ${theme.warn(message)}`);
}

export function printInfo(message: string): void {
  console.log(`  ${theme.info("ℹ")} ${theme.dim(message)}`);
}

export function printError(message: string, detail?: string): void {
  console.log(`  ${theme.error("✗")} ${message}`);
  if (detail) console.log(`    ${theme.dim(detail)}`);
}

export function printFileSaved(label: string, filepath: string): void {
  console.log(`  ${theme.dim(label)} ${theme.muted(filepath)}`);
}

export function printStuck(step: number): void {
  console.log(`  ${theme.warn("!")} ${theme.warn("Stuck")} ${theme.dim(`at step ${step}`)}`);
}

export function printRecovery(message: string): void {
  console.log(`  ${theme.info("↻")} ${theme.dim(message)}`);
}

export function printPreprocessor(message: string): void {
  printStepDetail(message);
}

// ─── HITL ────────────────────────────────────────────────

export function formatHITLPrompt(type: string, question: string, options?: string[]): string {
  let prompt = `\n  ${theme.info("?")} ${theme.info(`[${type.toUpperCase()}]`)} ${question}`;
  if (options && options.length > 0) {
    for (let i = 0; i < options.length; i++) {
      prompt += `\n     ${theme.dim(`${i + 1}.`)} ${options[i]}`;
    }
  }
  prompt += `\n  ${theme.brand(">")} `;
  return prompt;
}

export function printTimeout(): void {
  console.log(`  ${theme.dim("Timed out waiting for input")}`);
}

// ─── Token usage ─────────────────────────────────────────

export function printStepTokens(inputTokens: number, outputTokens: number): void {
  if (!Config.SHOW_TOKEN_USAGE) return;
  const total = inputTokens + outputTokens;
  console.log(`  ${" ".repeat(8)}${theme.dim(`⟠ ${total} tokens (in: ${inputTokens} out: ${outputTokens})`)}`);
}

export function printTokenSummary(
  totalInput: number,
  totalOutput: number,
  cost: number,
  modelName: string
): void {
  if (!Config.SHOW_TOKEN_USAGE) return;
  const total = totalInput + totalOutput;
  console.log();
  console.log(
    `  ${theme.label("Tokens")} ${theme.white(total.toLocaleString())}` +
    ` ${theme.dim(`(in: ${totalInput.toLocaleString()} out: ${totalOutput.toLocaleString()})`)}` +
    ` ${theme.dim("·")} ${theme.success(`$${cost.toFixed(4)}`)}` +
    ` ${theme.dim("·")} ${theme.dim(modelName)}`
  );
}

// ─── Explorer Agent ──────────────────────────────────────

export function printExplorerHeader(): void {
  console.log();
  console.log(boxTop("Explorer Agent"));
  console.log(boxEmpty());
  console.log(bxAuto(`   ${theme.brand("PRD → Think → Explore → Generate Flows")}`));
  console.log(boxEmpty());
  console.log(boxBottom());
  console.log();
}

export function printExplorerPhase(phase: string, message: string): void {
  const phaseColors: Record<string, (s: string) => string> = {
    Read: theme.info,
    Think: theme.brand,
    Explore: theme.step,
    Act: theme.success,
  };
  const colorFn = phaseColors[phase] ?? theme.dim;
  console.log();
  console.log(`  ${colorFn(`▸ ${phase}`)} ${theme.white(message)}`);
}

export function printExplorerAnalysis(analysis: {
  appName: string;
  appId?: string;
  features: Array<{ name: string; description: string }>;
  userJourneys: Array<{ name: string; priority: string; description: string }>;
  reasoning: string;
}): void {
  console.log();
  console.log(section("PRD Analysis"));
  console.log(`  ${theme.label("App")} ${theme.white(analysis.appName)}${analysis.appId ? theme.dim(` (${analysis.appId})`) : ""}`);
  console.log();

  console.log(`  ${theme.label("Features")}`);
  for (const f of analysis.features) {
    console.log(`    ${theme.dim("•")} ${theme.white(f.name)} ${theme.dim("—")} ${theme.dim(f.description)}`);
  }
  console.log();

  console.log(`  ${theme.label("Journeys")}`);
  for (const j of analysis.userJourneys) {
    const priorityColor = j.priority === "high" ? theme.error : j.priority === "medium" ? theme.warn : theme.dim;
    console.log(`    ${priorityColor(`[${j.priority}]`)} ${theme.white(j.name)}`);
    console.log(`          ${theme.dim(j.description)}`);
  }
  console.log();

  const reasonLines = wrapText(analysis.reasoning, 72, 2);
  for (const line of reasonLines.slice(0, 3)) {
    console.log(`  ${theme.dim(line)}`);
  }
}

export function printExplorerScreen(screenId: string, tappableCount: number, textCount: number): void {
  console.log(`    ${theme.success("+")} ${theme.step(screenId)} ${theme.dim(`(${tappableCount} tappable, ${textCount} texts)`)}`);
}

export function printExplorerAction(action: string): void {
  console.log(`    ${theme.dim("→")} ${theme.muted(action)}`);
}

export function printExplorerSummary(screenCount: number, transitionCount: number): void {
  console.log();
  console.log(`  ${theme.success("✓")} ${theme.success.bold("Crawl complete")} ${theme.dim(`— ${screenCount} screens, ${transitionCount} transitions`)}`);
}

export function printExplorerResults(
  flows: Array<{ name: string; description: string }>,
  files: string[],
): void {
  console.log();
  console.log(section("Generated Flows"));
  console.log();
  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    const file = files[i];
    console.log(`  ${theme.success("✓")} ${theme.dim(`${i + 1}.`)} ${theme.white(flow.name)}`);
    console.log(`       ${theme.dim(flow.description)}`);
    if (file) {
      console.log(`       ${theme.muted(file)}`);
    }
  }
  console.log();
  console.log(`  ${theme.success("✓")} ${theme.success.bold(`${flows.length} flows generated`)} ${theme.dim(`→ ${files[0] ? path.dirname(files[0]) : ""}`)}`);
  console.log();
}

// Re-export theme for ad-hoc use
export { theme };
