/**
 * Terminal UI — styled console output for AppClaw.
 *
 * Uses boxen for panels, cli-table3 for tables, gradient-string
 * for colored headers, marked-terminal for markdown, chalk for text.
 */

import chalk from 'chalk';
import cliSpinners from 'cli-spinners';
import path from 'node:path';
import readline from 'node:readline';
import boxen, { type Options as BoxenOptions } from 'boxen';
import Table from 'cli-table3';
import gradient from 'gradient-string';
import { marked } from 'marked';
// @ts-ignore — no types for marked-terminal
import { markedTerminal } from 'marked-terminal';

import { Config } from '../config.js';

// ─── Init ────────────────────────────────────────────────

marked.use(markedTerminal({ reflowText: true, width: 76, tab: 2 }) as any);

const appGradient: (text: string) => string = gradient(['#7C6FFF', '#6CB6FF']);
const successGradient: (text: string) => string = gradient(['#7C6FFF', '#22C55E']);

import { isJsonMode } from '../json-emitter.js';

/** No-op — kept for call-site compat. */
export async function initUI(): Promise<void> {}

/**
 * Suppress all console.log output in --json mode.
 * JSON events go via process.stdout.write in json-emitter.ts;
 * everything else (spinners, boxes, tables) must be silenced
 * so the bridge only sees clean NDJSON lines.
 */
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
const _origWrite = process.stdout.write.bind(process.stdout);

/** Call once after enableJsonMode() to silence terminal UI on stdout. */
export function silenceTerminalUI(): void {
  if (!isJsonMode()) {
    return;
  }
  console.log = (..._args: unknown[]) => {};
  console.warn = (..._args: unknown[]) => {};
  // Intercept stdout.write — only allow JSON lines through
  process.stdout.write = (chunk: any, ...rest: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    // Allow our NDJSON lines (start with '{') through
    const lines = str.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        _origWrite(trimmed + '\n');
      }
    }
    return true;
  };
}

// ─── Theme ───────────────────────────────────────────────

const theme = {
  brand: chalk.hex('#7C6FFF'),
  success: chalk.green,
  error: chalk.red,
  warn: chalk.yellow,
  dim: chalk.dim,
  bold: chalk.bold,
  muted: chalk.gray,
  info: chalk.cyan,
  white: chalk.white,
  step: chalk.hex('#6CB6FF'),
  label: chalk.hex('#9CA3AF'),
  badgeSkip: chalk.bgGreen.black,
  badgeAdapt: chalk.bgYellow.black,
  badgeProceed: chalk.bgCyan.black,
};

// ─── Rounded table chars ─────────────────────────────────

const ROUNDED_CHARS = {
  top: '─',
  'top-mid': '┬',
  'top-left': '╭',
  'top-right': '╮',
  bottom: '─',
  'bottom-mid': '┴',
  'bottom-left': '╰',
  'bottom-right': '╯',
  left: '│',
  'left-mid': '├',
  mid: '─',
  'mid-mid': '┼',
  right: '│',
  'right-mid': '┤',
  middle: '│',
};

// ─── Helpers ─────────────────────────────────────────────

function termWidth(): number {
  return Math.min(process.stdout.columns || 80, 120);
}

function visLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '').length;
}

function wrapText(text: string, maxWidth: number, indent: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : ' '.repeat(indent) + l));
}

function indent(text: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

// ─── Box (boxen) ─────────────────────────────────────────

function printBox(content: string, opts: BoxenOptions = {}): void {
  console.log(
    boxen(content, {
      padding: 1,
      margin: { left: 2 },
      borderStyle: 'round',
      borderColor: '#7C6FFF',
      ...opts,
    })
  );
}

// ─── Table (cli-table3) ─────────────────────────────────

interface TableOptions {
  headers: string[];
  rows: string[][];
  colWidths?: number[];
}

function printTable(opts: TableOptions): void {
  const table = new Table({
    head: opts.headers,
    style: { head: ['cyan'], border: ['gray'] },
    chars: ROUNDED_CHARS,
    ...(opts.colWidths ? { colWidths: opts.colWidths } : {}),
  });
  for (const row of opts.rows) {
    table.push(row);
  }
  console.log(indent(table.toString()));
}

// ─── Panel (boxen with title) ────────────────────────────

interface PanelOptions {
  title?: string;
  content: string;
  width?: number;
  borderColor?: string;
  dimBorder?: boolean;
}

function printPanel(opts: PanelOptions): void {
  printBox(opts.content, {
    title: opts.title,
    titleAlignment: 'left',
    width: opts.width,
    borderColor: opts.borderColor ?? '#7C6FFF',
    dimBorder: opts.dimBorder,
  });
}

// ─── Markdown (marked-terminal) ─────────────────────────

function printMarkdown(content: string): void {
  const rendered = (marked(content) as string).trimEnd();
  console.log(indent(rendered));
}

// ─── Horizontal rules ───────────────────────────────────

type HRStyle = 'single' | 'double' | 'dotted' | 'heavy';
const HR_CHARS: Record<HRStyle, string> = {
  single: '─',
  double: '═',
  dotted: '┄',
  heavy: '━',
};

function hr(style: HRStyle = 'single', width?: number, label?: string): string {
  const w = width ?? termWidth() - 4;
  const ch = HR_CHARS[style];
  if (label) {
    const labelStr = ` ${label} `;
    const left = 3;
    const right = Math.max(w - left - labelStr.length, 2);
    return `  ${theme.dim(ch.repeat(left))}${theme.label(labelStr)}${theme.dim(ch.repeat(right))}`;
  }
  return `  ${theme.dim(ch.repeat(w))}`;
}

// ─── Badge / pill ────────────────────────────────────────

function badge(text: string, colorFn: (s: string) => string, minWidth = 10): string {
  const padded =
    text.length < minWidth
      ? text.padStart(Math.ceil((minWidth + text.length) / 2)).padEnd(minWidth)
      : ` ${text} `;
  return colorFn(padded);
}

// ─── Progress bar ────────────────────────────────────────

function progressBar(current: number, total: number, width = 20): string {
  const ratio = Math.min(current / Math.max(total, 1), 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = theme.brand('█'.repeat(filled)) + theme.dim('░'.repeat(empty));
  const pct = theme.dim(`${Math.round(ratio * 100)}%`);
  return `${bar} ${theme.white(`${current}`)}${theme.dim(`/${total}`)} ${pct}`;
}

export function printProgressBar(current: number, total: number, width = 20): void {
  console.log(`  ${progressBar(current, total, width)}`);
}

// ─── Spinner ─────────────────────────────────────────────

const SPINNER = cliSpinners.dots;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;
let spinnerLineActive = false;
let spinnerPrimary = '';
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
  const mode = Config.AGENT_MODE === 'vision' ? 'vision' : 'dom';
  const think = Config.LLM_THINKING === 'on' ? 'thinking on' : 'thinking off';
  const m = modelName.trim() || 'model';
  const short = m.length > 40 ? `${m.slice(0, 37)}…` : m;
  return `${mode} · ${think} · ${short}`;
}

export function printAgentBullet(message: string): void {
  console.log(`  ${theme.muted('○')} ${theme.dim(message)}`);
}

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
  process.stdout.write('\x1B[?25l');
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
    process.stdout.write('\x1B[?25h');
    if (finalMessage) {
      process.stdout.write(finalMessage + '\n');
    }
  }
}

// ─── Streaming reasoning display ─────────────────────────

const STREAM_MAX_LINES = 5;
const STREAM_LINE_WIDTH = 72;
let streamLineCount = 0;
let streamBuffer = '';
let streamActive = false;
let streamLabel = '';

function cleanReasoningText(text: string): string {
  return text
    .replace(
      /\n?\s*(find_and_click|find_and_type|launch_app|go_back|go_home|done|ask_user)\s*(\([\s\S]*?\))?\s*$/i,
      ''
    )
    .trim();
}

export function startStreaming(label: string = 'Thinking'): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  spinnerLineActive = false;
  streamActive = true;
  streamBuffer = '';
  streamLineCount = 0;
  streamLabel = label;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`  ${theme.brand('┃')} ${theme.step(label)}\n`);
}

export function streamChunk(text: string): void {
  if (!streamActive) return;
  streamBuffer += text;
  const allLines = wrapStreamText(streamBuffer, STREAM_LINE_WIDTH);
  const visible = allLines.slice(-STREAM_MAX_LINES);
  eraseStreamLines();
  for (const line of visible) {
    process.stdout.write(`  ${theme.brand('┃')} ${theme.muted(line)}\n`);
  }
  streamLineCount = visible.length;
}

export function stopStreaming(): void {
  if (!streamActive) return;
  streamActive = false;
  eraseStreamLines();
  process.stdout.write('\x1B[1A');
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  const cleaned = cleanReasoningText(streamBuffer);
  if (cleaned) {
    const allLines = wrapStreamText(cleaned, STREAM_LINE_WIDTH);
    process.stdout.write(`  ${theme.dim('┃')} ${theme.dim(streamLabel)}\n`);
    for (const line of allLines) {
      process.stdout.write(`  ${theme.dim('┃')} ${theme.muted(line)}\n`);
    }
  }
  streamBuffer = '';
  streamLineCount = 0;
  process.stdout.write('\x1B[?25h');
}

function eraseStreamLines(): void {
  for (let i = 0; i < streamLineCount; i++) {
    process.stdout.write('\x1B[1A');
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

export function printReasoning(text: string): void {
  const cleaned = cleanReasoningText(text);
  if (!cleaned) return;
  const allLines = wrapStreamText(cleaned, STREAM_LINE_WIDTH);
  console.log(`  ${theme.dim('┃')} ${theme.dim('Reasoning')}`);
  for (const line of allLines) {
    console.log(`  ${theme.dim('┃')} ${theme.muted(line)}`);
  }
}

function wrapStreamText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ').filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
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

// ─── Header ──────────────────────────────────────────────

const LOGO_LINES = ['▄▀█ █▀█ █▀█ █▀▀ █   ▄▀█ █ █ █', '█▀█ █▀▀ █▀▀ █▄▄ █▄▄ █▀█ ▀▄▀▄▀'];

export function printHeader(version: string): void {
  const logo = LOGO_LINES.map((l) => appGradient(l)).join('\n');
  const content = [
    logo,
    '',
    theme.dim(`v${version}`),
    '',
    theme.muted('AI Mobile Testing Agent'),
  ].join('\n');

  console.log();
  printBox(content, {
    title: 'AppClaw',
    titleAlignment: 'left',
    padding: { left: 3, right: 3, top: 1, bottom: 1 },
    width: Math.min(termWidth() - 4, 56),
  });
  console.log();
}

export function printInteractiveHeader(): void {
  const logo = LOGO_LINES.map((l) => appGradient(l)).join('\n');
  const cmds = [
    `${theme.info('--record')}     ${theme.muted('Record actions for replay')}`,
    `${theme.info('--replay')}     ${theme.muted('Replay a recorded flow')}`,
    `${theme.info('--flow')}       ${theme.muted('Run steps from a YAML file')}`,
    `${theme.info('--playground')} ${theme.muted('Build YAML flows interactively')}`,
    `${theme.info('--plan')}       ${theme.muted('Decompose complex goals')}`,
    `${theme.info('--explore')}    ${theme.muted('Generate flows from a PRD')}`,
  ].join('\n');

  const content = [logo, '', theme.muted('AI Mobile Testing Agent'), '', cmds].join('\n');

  console.log();
  printBox(content, {
    title: 'AppClaw',
    titleAlignment: 'left',
    padding: { left: 3, right: 3, top: 1, bottom: 1 },
    width: Math.min(termWidth() - 4, 60),
  });
  console.log();
}

// ─── Config ──────────────────────────────────────────────

export function printConfig(entries: Array<[string, string]>): void {
  printTable({
    headers: ['Setting', 'Value'],
    rows: entries.map(([label, value]) => [label, value]),
  });
}

export function printSetupOk(message: string): void {
  console.log(`  ${theme.success('✓')} ${message}`);
}

export function printSetupError(message: string, hint?: string): void {
  console.log(`  ${theme.error('✗')} ${message}`);
  if (hint) console.log(`    ${theme.dim(hint)}`);
}

// ─── Goal ────────────────────────────────────────────────

export function printGoalStart(goal: string, maxSteps: number): void {
  const wrapped = wrapText(goal, 55, 0);
  const content = [
    ...wrapped.map((l) => chalk.bold(l)),
    '',
    `${theme.dim(`max ${maxSteps} steps`)}  ${progressBar(0, maxSteps, 15)}`,
  ].join('\n');

  console.log();
  printBox(content, { title: 'Goal', titleAlignment: 'left' });
  console.log();
}

export function printStep(
  step: number,
  maxSteps: number,
  toolName: string,
  argsSummary: string
): void {
  const counter = theme.dim(`[${step}/${maxSteps}]`.padEnd(8));

  if (toolName === 'find_and_click') {
    const visionMatch = argsSummary.match(/vision="([^"]+)"/);
    const selectorMatch = argsSummary.match(/selector="([^"]+)"/);
    const target = visionMatch?.[1] || selectorMatch?.[1] || argsSummary;
    const short = target.length > 65 ? target.slice(0, 62) + '…' : target;
    console.log(`  ${counter}${theme.step('tap')} ${theme.muted(short)}`);
    return;
  }
  if (toolName === 'find_and_type') {
    const visionMatch = argsSummary.match(/vision="([^"]+)"/);
    const selectorMatch = argsSummary.match(/selector="([^"]+)"/);
    const textMatch = argsSummary.match(/text="([^"]+)"/);
    const target = visionMatch?.[1] || selectorMatch?.[1] || 'field';
    const text = textMatch?.[1] || '';
    const short = target.length > 40 ? target.slice(0, 37) + '…' : target;
    console.log(
      `  ${counter}${theme.step('type')} ${theme.muted(`"${text}"`)} ${theme.dim(`→ ${short}`)}`
    );
    return;
  }
  if (toolName === 'done') {
    const reasonMatch = argsSummary.match(/reason="([^"]+)"/);
    const reason = reasonMatch?.[1] || argsSummary.replace(/^reason=/, '');
    const short = reason.length > 65 ? reason.slice(0, 62) + '…' : reason;
    console.log(`  ${counter}${theme.success('done')} ${theme.dim(short)}`);
    return;
  }

  const tool = theme.step(toolName);
  const args = argsSummary ? ` ${theme.muted(argsSummary)}` : '';
  console.log(`  ${counter}${tool}${args}`);
}

export function printStepDetail(message: string): void {
  console.log(`  ${' '.repeat(8)}${theme.dim('→')} ${theme.dim(message)}`);
}

export function printStepError(message: string): void {
  console.log(`  ${' '.repeat(8)}${theme.error('✗')} ${theme.error(message)}`);
}

export function printGoalSuccess(steps: number, reason: string): void {
  console.log();
  console.log(
    `  ${theme.success('✓')} ${theme.success.bold('Completed')} ${theme.dim(`in ${steps} steps`)}`
  );
  console.log(`    ${theme.dim(reason)}`);
  console.log(hr('single'));
}

export function printGoalFailed(reason: string): void {
  console.log();
  console.log(
    `  ${theme.error('✗')} ${theme.error.bold('Failed')} ${theme.dim('—')} ${theme.dim(reason)}`
  );
  console.log(hr('heavy'));
}

// ─── Plan ────────────────────────────────────────────────

export function printPlanStart(): void {
  startSpinner('Decomposing goal…', 'planner');
}

export function printPlan(subGoals: Array<{ goal: string }>, reasoning: string): void {
  const goalList = subGoals.map((sg, i) => `${theme.brand(`${i + 1}.`)} ${sg.goal}`).join('\n');
  const reasonLines = wrapText(reasoning, 68, 2).slice(0, 2);
  const content = [goalList, '', ...reasonLines.map((l) => theme.dim(l))].join('\n');

  console.log();
  printBox(content, { title: 'Plan', titleAlignment: 'left' });
  console.log();
}

export function printPlanContext(
  overallGoal: string,
  _currentGoal: string,
  allGoals: Array<{ goal: string; status: string }>,
  currentIndex: number
): void {
  console.log();
  console.log(`  ${theme.brand.bold('Progress')}`);
  console.log(
    `  ${theme.label('Goal:')} ${theme.white(overallGoal.length > 60 ? overallGoal.slice(0, 57) + '…' : overallGoal)}`
  );
  console.log();
  for (let i = 0; i < allGoals.length; i++) {
    const sg = allGoals[i];
    const num = `${i + 1}.`;
    if (sg.status === 'completed') {
      console.log(`  ${theme.success('✓')} ${theme.dim(num)} ${theme.dim(sg.goal)}`);
    } else if (i === currentIndex) {
      console.log(`  ${theme.brand('▸')} ${theme.white(num)} ${theme.white.bold(sg.goal)}`);
    } else {
      console.log(`  ${theme.dim('○')} ${theme.dim(num)} ${theme.dim(sg.goal)}`);
    }
  }
  console.log();
}

export function printSubGoalHeader(
  index: number,
  _total: number,
  _goal: string,
  allGoals: Array<{ goal: string; status: string }>
): void {
  printPlanContext('', _goal, allGoals, index);
}

export function printPlanSummary(
  subGoals: Array<{ goal: string; status: string; result?: string }>
): void {
  const passed = subGoals.filter((sg) => sg.status === 'completed').length;
  const failed = subGoals.length - passed;
  const tw = Math.min(termWidth() - 6, 90);

  console.log();
  console.log(hr('single', undefined, 'Summary'));
  console.log();

  const table = new Table({
    head: [
      chalk.hex('#9CA3AF')('#'),
      chalk.hex('#9CA3AF')('Goal'),
      chalk.hex('#9CA3AF')('Status'),
      chalk.hex('#9CA3AF')('Result'),
    ],
    style: { head: [], border: ['gray'] },
    chars: ROUNDED_CHARS,
    colWidths: [5, Math.floor(tw * 0.35), 10, Math.floor(tw * 0.45)],
    wordWrap: true,
  });

  for (let i = 0; i < subGoals.length; i++) {
    const sg = subGoals[i];
    const ok = sg.status === 'completed';
    const statusCell = ok ? chalk.green('● pass') : chalk.red('● fail');
    const goalCell = ok ? chalk.white(sg.goal) : chalk.red(sg.goal);
    const resultCell = ok ? chalk.green(sg.result ?? '') : chalk.red(sg.result ?? '');

    table.push([chalk.hex('#7C6FFF')(`${i + 1}`), goalCell, statusCell, resultCell]);
  }

  console.log(indent(table.toString()));
  console.log();

  // Summary line
  const allOk = passed === subGoals.length;
  const icon = allOk ? chalk.green('✓') : chalk.yellow('!');
  const passText = chalk.green.bold(`${passed} passed`);
  const failText = failed > 0 ? chalk.red.bold(` · ${failed} failed`) : '';
  console.log(`  ${icon} ${passText}${failText}  ${progressBar(passed, subGoals.length, 15)}`);
  console.log();
}

// ─── Orchestrator badges ─────────────────────────────────

export function printOrchestratorSkip(subGoal: string, reason: string): void {
  const pill = badge('SKIP', theme.badgeSkip);
  const goalShort = subGoal.length > 55 ? subGoal.slice(0, 52) + '…' : subGoal;
  console.log(`  ${pill} ${theme.dim(goalShort)}`);
  console.log(`    ${theme.dim(reason.length > 80 ? reason.slice(0, 77) + '…' : reason)}`);
}

export function printOrchestratorRewrite(original: string, rewritten: string): void {
  const pill = badge('ADAPT', theme.badgeAdapt);
  const origShort = original.length > 50 ? original.slice(0, 47) + '…' : original;
  console.log(`  ${pill} ${theme.dim(origShort)}`);
  console.log(
    `    ${theme.brand('→')} ${theme.white.bold(rewritten.length > 70 ? rewritten.slice(0, 67) + '…' : rewritten)}`
  );
}

export function printOrchestratorProceed(subGoal: string): void {
  const pill = badge('NEXT', theme.badgeProceed);
  console.log(`  ${pill} ${theme.white(subGoal)}`);
}

export function printScreenReadiness(issues: string[], suggestedAction?: string): void {
  console.log(`  ${theme.warn('⚠')} ${theme.warn('Screen not ready')}`);
  for (const issue of issues) {
    console.log(`    ${theme.dim('•')} ${theme.dim(issue)}`);
  }
  if (suggestedAction) {
    console.log(`    ${theme.brand('→')} ${theme.white(suggestedAction)}`);
  }
}

// ─── Replay / Flow ───────────────────────────────────────

export function printReplayHeader(filepath: string): void {
  console.log();
  console.log(`  ${theme.brand.bold('Replay')} ${theme.dim(filepath)}`);
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
  if (adapted) badges.push(theme.info(' adapted'));
  badges.push(success ? theme.success(' ok') : theme.error(' failed'));
  console.log(`  ${counter}${tool}${badges.join('')}`);
}

export function printYamlFlowHeader(filepath: string): void {
  console.log();
  console.log(`  ${theme.brand.bold('Flow')} ${theme.dim(filepath)}`);
}

export function printFlowStep(step: number, total: number, label: string, success: boolean): void {
  const counter = theme.dim(`[${step}/${total}]`.padEnd(8));
  const line = theme.step(label);
  const status = success ? theme.success(' ok') : theme.error(' failed');
  console.log(`  ${counter}${line}${status}`);
}

export function printReplayResult(passed: number, total: number, adapted: number): void {
  console.log();
  console.log(`  ${progressBar(passed, total, 25)}`);
  const allPassed = passed === total;
  const icon = allPassed ? theme.success('✓') : theme.warn('!');
  const status = allPassed
    ? theme.success.bold('All steps passed')
    : theme.warn.bold(`${passed}/${total} passed`);
  const adaptedNote = adapted > 0 ? theme.dim(` (${adapted} adapted)`) : '';
  console.log(`  ${icon} ${status}${adaptedNote}`);
  console.log();
}

// ─── Status / misc ───────────────────────────────────────

export function printWarning(message: string): void {
  console.log(`  ${theme.warn('!')} ${theme.warn(message)}`);
}

export function printInfo(message: string): void {
  console.log(`  ${theme.info('ℹ')} ${theme.dim(message)}`);
}

export function printError(message: string, detail?: string): void {
  console.log(`  ${theme.error('✗')} ${message}`);
  if (detail) console.log(`    ${theme.dim(detail)}`);
}

export function printFileSaved(label: string, filepath: string): void {
  console.log(`  ${theme.dim(label)} ${theme.muted(filepath)}`);
}

export function printStuck(step: number): void {
  console.log(`  ${theme.warn('!')} ${theme.warn('Stuck')} ${theme.dim(`at step ${step}`)}`);
}

export function printRecovery(message: string): void {
  console.log(`  ${theme.info('↻')} ${theme.dim(message)}`);
}

export function printPreprocessor(message: string): void {
  printStepDetail(message);
}

// ─── HITL ────────────────────────────────────────────────

export function formatHITLPrompt(type: string, question: string, options?: string[]): string {
  let prompt = `\n  ${theme.info('?')} ${theme.info(`[${type.toUpperCase()}]`)} ${question}`;
  if (options && options.length > 0) {
    for (let i = 0; i < options.length; i++) {
      prompt += `\n     ${theme.dim(`${i + 1}.`)} ${options[i]}`;
    }
  }
  prompt += `\n  ${theme.brand('>')} `;
  return prompt;
}

export function printTimeout(): void {
  console.log(`  ${theme.dim('Timed out waiting for input')}`);
}

// ─── Token usage ─────────────────────────────────────────

export function printStepTokens(inputTokens: number, outputTokens: number): void {
  if (!Config.SHOW_TOKEN_USAGE) return;
  const total = inputTokens + outputTokens;
  console.log(
    `  ${' '.repeat(8)}${theme.dim(`⟠ ${total} tokens (in: ${inputTokens} out: ${outputTokens})`)}`
  );
}

export function printTokenSummary(
  totalInput: number,
  totalOutput: number,
  cost: number,
  modelName: string
): void {
  if (!Config.SHOW_TOKEN_USAGE) return;
  const total = totalInput + totalOutput;
  const content = [
    `${chalk.hex('#9CA3AF')('Tokens')}  ${chalk.white.bold(total.toLocaleString())}  ${chalk.dim(`(in: ${totalInput.toLocaleString()}  out: ${totalOutput.toLocaleString()})`)}`,
    `${chalk.hex('#9CA3AF')('Cost')}    ${chalk.green.bold(`$${cost.toFixed(4)}`)}`,
    `${chalk.hex('#9CA3AF')('Model')}   ${chalk.dim(modelName)}`,
  ].join('\n');
  console.log();
  printBox(content, {
    padding: { left: 2, right: 2, top: 0, bottom: 0 },
    borderColor: 'gray',
    dimBorder: true,
  });
}

export function printJourneyTokenSummary(
  totalInput: number,
  totalOutput: number,
  totalCost: number,
  totalSteps: number,
  modelName: string
): void {
  const total = totalInput + totalOutput;
  if (total === 0) return;
  console.log();
  const content = [
    `${chalk.hex('#9CA3AF')('Tokens')}  ${chalk.white.bold(total.toLocaleString())}  ${chalk.dim(`(in: ${totalInput.toLocaleString()}  out: ${totalOutput.toLocaleString()})`)}`,
    `${chalk.hex('#9CA3AF')('Steps')}   ${chalk.hex('#7C6FFF').bold(`${totalSteps}`)}`,
    `${chalk.hex('#9CA3AF')('Cost')}    ${chalk.green.bold(`$${totalCost.toFixed(4)}`)}`,
    `${chalk.hex('#9CA3AF')('Model')}   ${chalk.dim(modelName)}`,
  ].join('\n');
  printBox(content, {
    title: 'Journey Summary',
    titleAlignment: 'left',
    padding: { left: 2, right: 2, top: 0, bottom: 0 },
  });
  console.log();
}

// ─── Explorer Agent ──────────────────────────────────────

export function printExplorerHeader(): void {
  const content = successGradient('PRD → Think → Explore → Generate Flows');
  console.log();
  printBox(content, {
    title: 'Explorer Agent',
    titleAlignment: 'left',
    width: Math.min(termWidth() - 4, 55),
  });
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
  const appLine = `${analysis.appName}${analysis.appId ? ` (${analysis.appId})` : ''}`;
  console.log();
  printBox(appLine, { title: 'PRD Analysis', titleAlignment: 'left' });
  console.log();

  printTable({
    headers: ['Feature', 'Description'],
    rows: analysis.features.map((f) => [f.name, f.description]),
  });
  console.log();

  printTable({
    headers: ['Priority', 'Journey', 'Description'],
    rows: analysis.userJourneys.map((j) => [j.priority, j.name, j.description]),
  });
  console.log();

  const reasonLines = wrapText(analysis.reasoning, 72, 2);
  for (const line of reasonLines.slice(0, 3)) {
    console.log(`  ${theme.dim(line)}`);
  }
}

export function printExplorerScreen(
  screenId: string,
  tappableCount: number,
  textCount: number
): void {
  console.log(
    `    ${theme.success('+')} ${theme.step(screenId)} ${theme.dim(`(${tappableCount} tappable, ${textCount} texts)`)}`
  );
}

export function printExplorerAction(action: string): void {
  console.log(`    ${theme.dim('→')} ${theme.muted(action)}`);
}

export function printExplorerSummary(screenCount: number, transitionCount: number): void {
  console.log();
  console.log(
    `  ${theme.success('✓')} ${theme.success.bold('Crawl complete')} ${theme.dim(`— ${screenCount} screens, ${transitionCount} transitions`)}`
  );
}

export function printExplorerResults(
  flows: Array<{ name: string; description: string }>,
  files: string[]
): void {
  console.log();
  console.log(hr('single', undefined, 'Generated Flows'));
  console.log();
  printTable({
    headers: ['#', 'Flow', 'Description', 'File'],
    rows: flows.map((flow, i) => [
      `${i + 1}`,
      flow.name,
      flow.description,
      files[i] ? path.basename(files[i]) : '',
    ]),
  });
  console.log();
  console.log(
    `  ${theme.success('✓')} ${theme.success.bold(`${flows.length} flows generated`)} ${theme.dim(`→ ${files[0] ? path.dirname(files[0]) : ''}`)}`
  );
  console.log();
}

// Re-export
export {
  theme,
  printTable,
  printPanel,
  printBox,
  printMarkdown,
  progressBar,
  hr,
  badge,
  appGradient,
  successGradient,
};
