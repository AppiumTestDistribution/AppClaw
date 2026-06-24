/**
 * Playground — interactive REPL that connects to a real device,
 * executes commands live, and records steps for YAML export.
 *
 * Type natural-language commands (tap, swipe, type, etc.)
 * → each one runs immediately on the device via Appium
 * → accumulated steps can be exported as a YAML flow file.
 */

import readline from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { stringify } from 'yaml';

import { loadConfig, Config } from '../config.js';
import { createMCPClient } from '../mcp/client.js';
import { extractText } from '../mcp/tools.js';
import { setupDevice } from '../device/index.js';
import { AppResolver } from '../agent/app-resolver.js';
import { tryParseNaturalFlowLine } from '../flow/natural-line.js';
import { runOneInstruction, DEFAULT_MIN_MATCH_SCORE } from '../flow/run-instruction.js';
import { resetVisionTokens, getVisionTokens } from '../vision/vision-token-tracker.js';
import { MODEL_PRICING, DEFAULT_MODELS } from '../constants.js';
import { getStarkVisionModel, isVisionLocateEnabled } from '../vision/locate-enabled.js';
import { generateSdkTestFromInstructions } from '../sdk/goal-export.js';
import { stepAction, stepTarget } from '../ui/step-printer.js';
import type { FlowStep, FlowMeta } from '../flow/types.js';
import type { MCPClient } from '../mcp/types.js';
import {
  theme,
  printBox,
  printPanel,
  printTable,
  hr,
  appGradient,
  printMarkdown,
  progressBar,
} from '../ui/terminal.js';
import * as ui from '../ui/terminal.js';
import Table from 'cli-table3';

// executeStep / FlowTapPollOptions are now consumed by src/flow/run-instruction.js
import { loadStore, getTrajectoryStorePath } from '../memory/store.js';
import { loadProcedures, getProceduresStorePath } from '../memory/procedures.js';

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

// ─── Cost helpers ───────────────────────────────────────

function calcCost(inputTokens: number, outputTokens: number, modelName: string): number {
  const pricing = MODEL_PRICING[modelName] ?? [0, 0];
  return (inputTokens / 1_000_000) * pricing[0] + (outputTokens / 1_000_000) * pricing[1];
}

function visionCost(inputTokens: number, outputTokens: number): number {
  return calcCost(inputTokens, outputTokens, getStarkVisionModel());
}

function llmCost(inputTokens: number, outputTokens: number): number {
  const modelName = Config.LLM_MODEL || DEFAULT_MODELS[Config.LLM_PROVIDER] || '';
  return calcCost(inputTokens, outputTokens, modelName);
}

// ─── Formatting helpers ─────────────────────────────────

// `stepAction` and `stepTarget` live in src/ui/step-printer.ts so the SDK's
// StepRunner can use the same formatting. Imported below from that module.

function stepToDisplay(step: FlowStep, index: number): string {
  const num = theme.brand(`${(index + 1).toString().padStart(2)}.`);
  const action = theme.step.bold(stepAction(step).padEnd(7));
  const target = theme.white(stepTarget(step));
  return `${num} ${action} ${target}`;
}

function spinnerDetail(step: FlowStep): string {
  switch (step.kind) {
    case 'tap':
      return 'tapping the screen…';
    case 'longPress':
      return 'long-pressing the screen…';
    case 'type':
      return 'typing into the field…';
    case 'swipe':
      return 'swiping the screen…';
    case 'zoom':
      return `zooming ${step.scale >= 1 ? 'in' : 'out'}…`;
    case 'scrollAssert':
      return 'scanning the screen…';
    case 'assert':
      return 'verifying the screen…';
    case 'launchApp':
      return 'launching the app…';
    case 'openApp':
      return 'opening the app…';
    case 'wait':
      return 'waiting…';
    case 'waitUntil':
      return 'waiting for condition…';
    case 'enter':
      return 'pressing enter…';
    case 'back':
      return 'navigating back…';
    case 'home':
      return 'going home…';
    case 'getInfo':
      return 'reading the screen…';
    case 'done':
      return 'wrapping up…';
    default:
      return 'executing on device…';
  }
}

// Action glyph per step kind — mirrors the Ink StepLine look.
const KIND_ICON: Record<string, string> = {
  tap: '●',
  longPress: '●',
  type: '⊞',
  swipe: '↕',
  scrollAssert: '↕',
  zoom: '⊕',
  drag: '↔',
  assert: '◈',
  launchApp: '↗',
  openApp: '↗',
  wait: '…',
  waitUntil: '…',
  enter: '↵',
  back: '‹',
  home: '⌂',
  getInfo: '◎',
  done: '✓',
};

function fmtMs(ms?: number): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Colorful, aligned single-line step row (matches the Ink RunScreen vibe):
 *
 *   ✓  3  tap     "Login"                         ●  0.8s
 *           ↳ Tapped "Login"
 */
function printPlaygroundStep(
  stepNum: number,
  step: FlowStep,
  success: boolean,
  message: string,
  ms?: number
): void {
  const TARGET_W = 42;
  const icon = success ? theme.success('✓') : theme.error('✗');
  const num = theme.dim(String(stepNum).padStart(2));
  const verbRaw = stepAction(step).padEnd(8);
  const verb = success ? theme.step.bold(verbRaw) : theme.error.bold(verbRaw);
  const targetRaw = stepTarget(step);
  const targetPadded =
    targetRaw.length > TARGET_W
      ? targetRaw.slice(0, TARGET_W - 1) + '…'
      : targetRaw.padEnd(TARGET_W);
  const target = success ? theme.white(targetPadded) : theme.error(targetPadded);
  const glyph = theme.muted(KIND_ICON[step.kind] ?? '●');
  const dur = theme.dim(fmtMs(ms).padStart(6));

  console.log(`  ${icon}  ${num}  ${verb}${target} ${glyph}  ${dur}`);
  if (message && message !== 'recorded') {
    console.log(`         ${success ? theme.dim('↳ ' + message) : theme.error('↳ ' + message)}`);
  }
}

function printStepSuccess(stepNum: number, step: FlowStep, message: string, ms?: number): void {
  printPlaygroundStep(stepNum, step, true, message, ms);
}

function printStepFail(stepNum: number, step: FlowStep, message: string, ms?: number): void {
  printPlaygroundStep(stepNum, step, false, message, ms);
}

/**
 * Minimum matchScore (1-10) required to execute a tap in the playground.
 * Below this threshold, vision found a loose match — show suggestion but don't execute.
 *
 * Re-exported from `src/flow/run-instruction.ts` so the SDK and playground share
 * one source of truth (used to be defined twice, leading to drift risk).
 */
const MIN_MATCH_SCORE = DEFAULT_MIN_MATCH_SCORE;

/** Convert step to YAML — preserve the user's original natural language input. */
function stepToYaml(step: FlowStep): unknown {
  // Playground steps always have verbatim (the exact text the user typed).
  // Use it directly so the YAML reads like the user's instructions.
  if (step.verbatim) return step.verbatim;

  // Fallback for steps without verbatim (shouldn't happen in playground)
  switch (step.kind) {
    case 'launchApp':
      return 'launchApp';
    case 'openApp':
      return `open ${step.query} app`;
    case 'tap':
      return `tap ${step.label}`;
    case 'longPress':
      return step.duration != null
        ? `long press ${step.label} for ${step.duration}ms`
        : `long press ${step.label}`;
    case 'type':
      return `type "${step.text}"`;
    case 'swipe':
      return `swipe ${step.direction}`;
    case 'zoom':
      return step.target
        ? `zoom ${step.scale >= 1 ? 'in' : 'out'} ${step.scale}x on ${step.target}`
        : `zoom ${step.scale >= 1 ? 'in' : 'out'} ${step.scale}x`;
    case 'wait':
      return `wait ${step.seconds} s`;
    case 'waitUntil':
      if (step.condition === 'screenLoaded') return 'wait until screen is loaded';
      if (step.condition === 'gone') return `wait until "${step.text}" is gone`;
      return `wait until "${step.text}" is visible`;
    case 'enter':
      return 'press enter';
    case 'back':
      return 'go back';
    case 'home':
      return 'go home';
    case 'assert':
      return `assert "${step.text}" is visible`;
    case 'scrollAssert':
      return `scroll ${step.direction} until "${step.text}" is visible`;
    case 'getInfo':
      return `getInfo: ${step.query}`;
    case 'done':
      return step.message ? `done: ${step.message}` : 'done';
  }
}

function buildYamlString(): string {
  const parts: string[] = [];

  if (state.meta.appId || state.meta.name || state.meta.platform) {
    const metaObj: Record<string, string> = {};
    if (state.meta.appId) metaObj.appId = state.meta.appId;
    if (state.meta.name) metaObj.name = state.meta.name;
    if (state.meta.platform) metaObj.platform = state.meta.platform;
    parts.push(stringify(metaObj).trim());
    parts.push('---');
  }

  const yamlSteps = state.steps.map(stepToYaml);

  // Auto-append "done" if the last step isn't already a done step
  const lastStep = state.steps[state.steps.length - 1];
  if (!lastStep || lastStep.kind !== 'done') {
    yamlSteps.push('done');
  }

  parts.push(stringify({ steps: yamlSteps }).trim());

  return parts.join('\n') + '\n';
}

/**
 * Whether the given filename should be exported as a vitest spec (SDK test
 * format) rather than the default YAML flow format.
 */
function isSdkTestFilename(name: string): boolean {
  return /\.(?:test|spec)\.(?:m|c)?[jt]sx?$/i.test(name) || /\.(?:m|c)?ts$/i.test(name);
}

/**
 * Resolve the final on-disk path for an `/export` write — same rules as the
 * CLI's `--export`. Bare filenames land in the configured directory (EXPORT_DIR);
 * paths with a directory hint (./tests/foo.test.ts, /abs/...) are used verbatim.
 *
 * The configured directory differs by format: SDK tests go to EXPORT_DIR, YAML
 * flows stay in cwd (mirrors the original playground behaviour).
 */
function resolvePlaygroundExportPath(filename: string, asSdkTest: boolean): string {
  if (path.isAbsolute(filename)) return filename;
  if (filename.includes('/') || filename.includes(path.sep)) {
    return path.resolve(process.cwd(), filename);
  }
  if (asSdkTest) {
    const dir = _deviceArgs.exportDir ?? loadConfig().EXPORT_DIR;
    return path.resolve(process.cwd(), dir, filename);
  }
  return path.resolve(process.cwd(), filename);
}

/**
 * Build the vitest spec body for the current playground state.
 * Each recorded step's `verbatim` (the user's original natural-language text)
 * becomes one `await app.run(...)` call — no translation needed because the
 * playground already accepts the same syntax that `AppClaw.run()` does.
 */
function buildSdkTestString(): string {
  const instructions = state.steps
    .map((s) => s.verbatim?.trim())
    .filter((v): v is string => !!v && v.length > 0);
  return generateSdkTestFromInstructions({
    instructions,
    config: {
      describeName: state.meta.name || 'Recorded flow',
      ...(state.meta.platform === 'ios' || state.meta.platform === 'android'
        ? { platform: state.meta.platform }
        : {}),
    },
  });
}

/** Light syntax tint for a single code line — strings green, comments dim. */
function highlightCodeLine(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return theme.dim(line);
  }
  // eslint-disable-next-line no-useless-escape
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, (m) => chalk.hex('#22C55E')(m));
}

/**
 * Render a syntax-tinted, line-numbered preview of generated export code in a
 * bordered box. Used by `/export` (before writing) and `/preview`.
 */
function printCodePreview(body: string, filename: string, label: string): void {
  const MAX_LINES = 60;
  const lines = body.replace(/\n+$/, '').split('\n');
  const shown = lines.slice(0, MAX_LINES);
  const gutter = String(shown.length).length;
  const rendered = shown
    .map((l, i) => `${theme.dim(String(i + 1).padStart(gutter))}  ${highlightCodeLine(l)}`)
    .join('\n');
  const more =
    lines.length > MAX_LINES ? `\n${theme.dim(`… +${lines.length - MAX_LINES} more lines`)}` : '';
  console.log();
  printBox(rendered + more, {
    title: `Preview · ${path.basename(filename)} · ${label}`,
    titleAlignment: 'left',
    borderColor: '#FC8EAC',
  });
}

function printStepList(): void {
  if (state.steps.length === 0) return;

  const title = state.meta.name
    ? `${state.meta.name}${state.meta.appId ? ` (${state.meta.appId})` : ''}`
    : state.meta.appId
      ? state.meta.appId
      : 'Flow';

  const table = new Table({
    head: [
      chalk.hex('#9CA3AF')('#'),
      chalk.hex('#9CA3AF')('Action'),
      chalk.hex('#9CA3AF')('Target'),
      chalk.hex('#9CA3AF')('Status'),
    ],
    style: { head: [], border: ['gray'] },
    chars: {
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
    },
    colWidths: [5, 10, 40, 10],
    wordWrap: true,
  });

  for (let i = 0; i < state.steps.length; i++) {
    const step = state.steps[i];
    const action = stepAction(step);
    const target = stepTarget(step);
    const actionColored = chalk.hex('#9CC6F5').bold(action);
    const statusColored = chalk.green('● pass');

    table.push([
      chalk.hex('#FC8EAC')(`${i + 1}`),
      actionColored,
      chalk.white(target),
      statusColored,
    ]);
  }

  console.log();
  console.log(`  ${chalk.hex('#FC8EAC').bold(title)}`);
  console.log(`  ${table.toString().split('\n').join('\n  ')}`);
  console.log();
  console.log(
    `  ${chalk.green('✓')} ${chalk.green.bold(`${state.steps.length}`)} ${chalk.dim(`step${state.steps.length === 1 ? '' : 's'} recorded`)}  ${progressBar(state.steps.length, state.steps.length, 15)}`
  );
  console.log();
}

// Step execution is delegated to runOneInstruction() in src/flow/run-instruction.js.
// The playground used to have its own runStepOnDevice() wrapper; that became dead
// code after the shared pipeline refactor.

// ─── Memory inspection ──────────────────────────────────

function runMemoryCommand(arg: string): void {
  const sub = (arg || 'stats').toLowerCase();
  if (sub === 'stats') return printMemoryStats();
  if (sub === 'list') return printMemoryProcedureList();
  if (sub === 'paths') return printMemoryPaths();
  console.log(`  ${theme.label('Usage:')} /memory stats  |  /memory list  |  /memory paths`);
}

function printMemoryPaths(): void {
  const trajPath = getTrajectoryStorePath(Config.EPISODIC_MEMORY_PATH || undefined);
  const procPath = getProceduresStorePath(Config.PROCEDURAL_MEMORY_PATH || undefined);
  console.log();
  console.log(`  ${theme.label('Trajectories:')} ${theme.white(trajPath)}`);
  console.log(`  ${theme.label('Procedures:  ')} ${theme.white(procPath)}`);
  console.log(`  ${theme.label('Namespace:   ')} ${theme.white(Config.APPCLAW_MEMORY_NAMESPACE)}`);
  console.log();
}

function printMemoryStats(): void {
  const trajPath = getTrajectoryStorePath(Config.EPISODIC_MEMORY_PATH || undefined);
  const procPath = getProceduresStorePath(Config.PROCEDURAL_MEMORY_PATH || undefined);
  const trajStore = loadStore(Config.EPISODIC_MEMORY_PATH || undefined);
  const procStore = loadProcedures(Config.PROCEDURAL_MEMORY_PATH || undefined);
  const ns = Config.APPCLAW_MEMORY_NAMESPACE;

  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const trajNs = trajStore.entries.filter((e) => (e.namespace ?? 'default') === ns);
  const procNs = procStore.entries.filter((e) => e.namespace === ns);
  const trajStale = trajNs.filter(
    (e) => e.successCount < 2 && Date.now() - e.timestamp > SEVEN_DAYS
  ).length;

  const groupByApp = <T extends { appId: string }>(arr: T[]): Array<[string, number]> => {
    const m = new Map<string, number>();
    for (const e of arr) m.set(e.appId, (m.get(e.appId) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  console.log();
  console.log(hr('single', undefined, 'Memory stats'));
  console.log();
  console.log(`  ${theme.label('Namespace:')} ${theme.white(ns)}`);
  console.log();

  // Episodic
  console.log(
    `  ${theme.label('Episodic')}  ${theme.dim(`(${trajPath})`)}\n` +
      `    ${theme.label('Total:')}      ${theme.white(String(trajStore.entries.length))}` +
      `  ${theme.dim(`(${trajNs.length} in this namespace)`)}\n` +
      `    ${theme.label('Stale-eligible:')} ${theme.white(String(trajStale))} ${theme.dim('(single-use, >7d — hidden from retrieval)')}`
  );
  const trajByApp = groupByApp(trajNs);
  if (trajByApp.length > 0) {
    console.log(`    ${theme.label('By app:')}`);
    for (const [appId, n] of trajByApp.slice(0, 8)) {
      console.log(
        `      ${theme.dim('•')} ${theme.white(appId.padEnd(40))} ${theme.dim(String(n))}`
      );
    }
  }
  console.log();

  // Procedural
  console.log(
    `  ${theme.label('Procedural')}  ${theme.dim(`(${procPath})`)}\n` +
      `    ${theme.label('Total:')} ${theme.white(String(procStore.entries.length))}` +
      `  ${theme.dim(`(${procNs.length} in this namespace)`)}`
  );
  const procByApp = groupByApp(procNs);
  if (procByApp.length > 0) {
    console.log(`    ${theme.label('By app:')}`);
    for (const [appId, n] of procByApp.slice(0, 8)) {
      console.log(
        `      ${theme.dim('•')} ${theme.white(appId.padEnd(40))} ${theme.dim(String(n))}`
      );
    }
  }
  console.log();
  console.log(theme.dim(`  Type /memory list to see goal recipes, /memory paths for file paths.`));
  console.log();
}

function printMemoryProcedureList(): void {
  const store = loadProcedures(Config.PROCEDURAL_MEMORY_PATH || undefined);
  const ns = Config.APPCLAW_MEMORY_NAMESPACE;
  const items = store.entries.filter((e) => e.namespace === ns);

  if (items.length === 0) {
    console.log();
    console.log(
      `  ${theme.dim(`No procedures yet in namespace "${ns}". Run a goal to record one.`)}`
    );
    console.log();
    return;
  }

  items.sort((a, b) => b.timestamp - a.timestamp);

  console.log();
  console.log(hr('single', undefined, `Procedures (${items.length} in namespace "${ns}")`));
  console.log();
  for (const p of items.slice(0, 20)) {
    const ago = formatProcAgo(p.timestamp);
    const goal = p.goalKeywords.join(' ');
    const reuse = p.successCount > 1 ? ` ${theme.success(`×${p.successCount}`)}` : '';
    console.log(
      `  ${theme.dim('•')} ${theme.white(goal)}${reuse}` +
        ` ${theme.dim(`— ${p.appId}, ${p.steps.length} steps, ${ago}`)}`
    );
  }
  console.log();
}

function formatProcAgo(ts: number): string {
  const days = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ─── Slash commands ─────────────────────────────────────

const COMMANDS: Record<string, { desc: string; run: (arg: string) => Promise<void> | void }> = {
  '/help': {
    desc: 'Show available commands and supported step patterns',
    run: () => printHelp(),
  },
  '/list': {
    desc: 'List all recorded steps',
    run: () => {
      if (state.steps.length === 0) {
        console.log(
          `\n  ${theme.dim('No steps yet. Type a command like:')} ${theme.white('open youtube app')}\n`
        );
        return;
      }
      printStepList();
    },
  },
  '/yaml': {
    desc: 'Preview the YAML output',
    run: () => {
      if (state.steps.length === 0) {
        console.log(`\n  ${theme.dim('No steps to preview.')}\n`);
        return;
      }
      const yamlStr = buildYamlString();
      console.log();
      // Print YAML with cyan coloring (not markdown — marked-terminal renders YAML as red)
      for (const line of yamlStr.split('\n')) {
        console.log(`    ${chalk.cyan(line)}`);
      }
      console.log(`  ${theme.dim('Use')} ${theme.info('/export <file>')} ${theme.dim('to save')}`);
      console.log();
    },
  },
  '/preview': {
    desc: 'Preview the generated code without saving (optionally pass a filename for format)',
    run: (arg: string) => {
      if (state.steps.length === 0) {
        console.log(`\n  ${theme.error('✗')} No steps to preview.\n`);
        return;
      }
      const filename = arg.trim() || `flow-${Date.now()}.test.ts`;
      const asSdkTest = isSdkTestFilename(filename);
      const body = asSdkTest ? buildSdkTestString() : buildYamlString();
      const formatLabel = asSdkTest ? 'SDK test (vitest)' : 'YAML flow';
      printCodePreview(body, filename, formatLabel);
      console.log(
        `  ${theme.dim('Use')} ${theme.info(`/export ${arg.trim() || '<file>'}`)} ${theme.dim('to save.')}\n`
      );
    },
  },
  '/export': {
    desc:
      'Export steps. SDK vitest test by default (e.g. /export my-flow.test.ts) ' +
      'or YAML flow by extension (.yaml/.yml).',
    run: (arg: string) => {
      if (state.steps.length === 0) {
        console.log(`\n  ${theme.error('✗')} No steps to export.\n`);
        return;
      }
      const filename = arg.trim() || `flow-${Date.now()}.test.ts`;
      const asSdkTest = isSdkTestFilename(filename);
      const filepath = resolvePlaygroundExportPath(filename, asSdkTest);
      const body = asSdkTest ? buildSdkTestString() : buildYamlString();
      const formatLabel = asSdkTest ? 'SDK test (vitest)' : 'YAML flow';

      // Show the generated code before writing it.
      printCodePreview(body, filepath, formatLabel);

      mkdirSync(path.dirname(filepath), { recursive: true });
      writeFileSync(filepath, body, 'utf-8');
      const runHint = asSdkTest
        ? `vitest run ${path.relative(process.cwd(), filepath)}`
        : `appclaw --flow ${path.relative(process.cwd(), filepath)}`;
      const exportContent = [
        `${chalk.green.bold(`${state.steps.length}`)} ${chalk.dim('steps exported as')} ${chalk.white(formatLabel)}`,
        '',
        `${chalk.dim('File:')} ${chalk.white(filepath)}`,
        `${chalk.dim('Run:')}  ${chalk.cyan(runHint)}`,
      ].join('\n');
      console.log();
      printBox(exportContent, {
        title: 'Exported',
        titleAlignment: 'left',
        borderColor: '#22C55E',
      });
      console.log();
    },
  },
  '/undo': {
    desc: 'Remove the last step',
    run: () => {
      if (state.steps.length === 0) {
        console.log(`  ${theme.dim('Nothing to undo.')}`);
        return;
      }
      const removed = state.steps.pop()!;
      console.log(`  ${theme.warn('↩')} Removed: ${theme.dim(removed.verbatim ?? removed.kind)}`);
      if (state.steps.length > 0) {
        printStepList();
      } else {
        console.log(`  ${theme.dim('All steps cleared.')}`);
      }
    },
  },
  '/clear': {
    desc: 'Clear all steps and metadata',
    run: () => {
      const count = state.steps.length;
      state.steps.length = 0;
      state.meta = {};
      console.log(`  ${theme.warn('↩')} Cleared ${count} steps.`);
    },
  },
  '/meta': {
    desc: 'Set flow metadata (e.g. /meta appId com.android.settings, /meta platform ios)',
    run: (arg: string) => {
      const parts = arg.trim().split(/\s+/);
      const key = parts[0];
      const value = parts.slice(1).join(' ');
      if (key === 'appId' && value) {
        state.meta.appId = value;
        console.log(`  ${theme.success('✓')} appId = ${theme.white(value)}`);
      } else if (key === 'name' && value) {
        state.meta.name = value;
        console.log(`  ${theme.success('✓')} name = ${theme.white(value)}`);
      } else if (key === 'platform') {
        const p = value.toLowerCase();
        if (p === 'android' || p === 'ios') {
          state.meta.platform = p;
          console.log(`  ${theme.success('✓')} platform = ${theme.white(p)}`);
        } else {
          console.log(`  ${theme.label('Usage:')} /meta platform <android|ios>`);
        }
      } else {
        console.log(
          `  ${theme.label('Usage:')} /meta appId <package.id>  |  /meta name <flow name>  |  /meta platform <android|ios>`
        );
        if (state.meta.appId || state.meta.name || state.meta.platform) {
          console.log(`  ${theme.label('Current:')}`);
          if (state.meta.appId) console.log(`    appId:    ${theme.white(state.meta.appId)}`);
          if (state.meta.name) console.log(`    name:     ${theme.white(state.meta.name)}`);
          if (state.meta.platform) console.log(`    platform: ${theme.white(state.meta.platform)}`);
        }
      }
    },
  },
  '/edit': {
    desc: 'Edit a step by number (e.g. /edit 3 tap "Settings")',
    run: (arg: string) => {
      const match = arg.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        console.log(`  ${theme.label('Usage:')} /edit <number> <new command>`);
        return;
      }
      const idx = parseInt(match[1], 10) - 1;
      if (idx < 0 || idx >= state.steps.length) {
        console.log(
          `  ${theme.error('✗')} Step ${idx + 1} does not exist (1–${state.steps.length}).`
        );
        return;
      }
      const parsed = tryParseNaturalFlowLine(match[2]);
      if (!parsed) {
        console.log(`  ${theme.error('✗')} Could not parse: ${theme.dim(match[2])}`);
        return;
      }
      state.steps[idx] = parsed;
      console.log(`  ${theme.success('✓')} Updated step ${idx + 1}`);
      printStepList();
    },
  },
  '/insert': {
    desc: 'Insert a step at position (e.g. /insert 2 wait 3 s)',
    run: (arg: string) => {
      const match = arg.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        console.log(`  ${theme.label('Usage:')} /insert <position> <command>`);
        return;
      }
      const idx = parseInt(match[1], 10) - 1;
      if (idx < 0 || idx > state.steps.length) {
        console.log(`  ${theme.error('✗')} Position must be 1–${state.steps.length + 1}.`);
        return;
      }
      const parsed = tryParseNaturalFlowLine(match[2]);
      if (!parsed) {
        console.log(`  ${theme.error('✗')} Could not parse: ${theme.dim(match[2])}`);
        return;
      }
      state.steps.splice(idx, 0, parsed);
      console.log(`  ${theme.success('✓')} Inserted at position ${idx + 1}`);
      printStepList();
    },
  },
  '/delete': {
    desc: 'Delete a step by number (e.g. /delete 3)',
    run: (arg: string) => {
      const idx = parseInt(arg.trim(), 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= state.steps.length) {
        console.log(`  ${theme.error('✗')} Invalid step number. Use 1–${state.steps.length}.`);
        return;
      }
      const removed = state.steps.splice(idx, 1)[0];
      console.log(`  ${theme.warn('↩')} Deleted: ${theme.dim(removed.verbatim ?? removed.kind)}`);
      if (state.steps.length > 0) {
        printStepList();
      }
    },
  },
  '/memory': {
    desc: 'Inspect episodic + procedural memory (e.g. /memory stats, /memory list)',
    run: (arg: string) => runMemoryCommand(arg.trim()),
  },
};

function printHelp(): void {
  console.log();
  console.log(hr('single', undefined, 'Commands'));
  console.log();
  printTable({
    headers: ['Command', 'Description'],
    rows: [
      ...Object.entries(COMMANDS).map(([cmd, { desc }]) => [cmd, desc]),
      ['/quit', 'Exit playground'],
    ],
  });
  console.log();
  console.log(hr('single', undefined, 'Examples'));
  console.log(`  ${theme.dim('Type natural commands — they run on the device instantly')}`);
  console.log();

  const examples: Array<{ category: string; lines: string[] }> = [
    {
      category: 'Apps',
      lines: ['open YouTube', 'launch Settings app', 'close YouTube', 'close the app'],
    },
    {
      category: 'Tap & Navigate',
      lines: [
        'tap on Login',
        'click Search button',
        'select English',
        'navigate to Settings screen',
      ],
    },
    {
      category: 'Proximity (disambiguate by position)',
      lines: [
        'tap the login button below the password field',
        'tap the icon to the right of the title',
        'click the checkbox next to Terms',
        'type "pass" in the field below the email',
      ],
    },
    {
      category: 'Long Press',
      lines: [
        'long press on first email',
        'long-press the image',
        'press and hold Delete button',
        'long press on file for 1500ms',
      ],
    },
    {
      category: 'Type & Search',
      lines: [
        'type "hello world"',
        'type "john" in Username field',
        'search for appium 3.0',
        'press enter',
      ],
    },
    {
      category: 'Scroll & Swipe',
      lines: [
        'scroll down',
        'swipe left',
        'scroll down 2 times until "Krishna" is visible',
        'scroll up to find "Notifications"',
      ],
    },
    {
      category: 'Assert (recorded as a pass/fail step in your flow)',
      lines: [
        'assert "Welcome" is visible',
        'verify "Login" is displayed',
        'verify bell icon is present',
        'check red dot in the map',
      ],
    },
    {
      category: 'Ask (inspect the screen — not recorded)',
      lines: [
        'Is there a bell icon on screen?',
        'What text is shown in the header?',
        'Is the map loaded?',
        'How many items are in the list?',
      ],
    },
    {
      category: 'Wait & Sync',
      lines: [
        'wait 3 s',
        'wait until screen is loaded',
        'wait until "Search results" is visible',
        'wait until "Loading..." is gone',
        'wait 5s until search icon is visible',
        'wait 15s until screen is loaded',
      ],
    },
    {
      category: 'Device Controls',
      lines: ['go back', 'go home', 'toggle WiFi', 'close popup'],
    },
    {
      category: 'Flow',
      lines: ['done', 'done: login flow finished'],
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
      console.log(`    ${theme.info('›')} ${line}`);
    }
    console.log();
  }
}

// ─── Header ─────────────────────────────────────────────

function printPlaygroundHeader(): void {
  const content = [
    appGradient('Execute commands live & export as an SDK test'),
    '',
    `${theme.dim('Commands run on device immediately.')}`,
    `${theme.dim('Use')} ${theme.info('/yaml')} ${theme.dim('to preview and')} ${theme.info('/export')} ${theme.dim('to save.')}`,
    `${theme.dim('Type')} ${theme.info('/help')} ${theme.dim('for all commands.')}`,
  ].join('\n');

  console.log();
  printBox(content, { title: 'AppClaw Playground', titleAlignment: 'left' });
  console.log();
}

// ─── Prompt ─────────────────────────────────────────────

function getPrompt(): string {
  return `\n  ${chalk.hex('#FC8EAC').bold('›')} `;
}

// ─── Device connection ──────────────────────────────────

let _resolvedPlatform: 'android' | 'ios' = 'android';

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
    ui.printSetupOk('Connected to appium-mcp');

    // Full device setup pipeline (platform → device → iOS setup → session)
    const deviceResult = await setupDevice(mcpClient, {
      cliPlatform: _deviceArgs.platform ?? null,
      cliDeviceType: _deviceArgs.deviceType ?? null,
      cliUdid: _deviceArgs.udid ?? null,
      cliDeviceName: _deviceArgs.deviceName ?? null,
      config,
      alwaysPickDevice: true,
    });
    _resolvedPlatform = deviceResult.platform;

    // Auto-set platform in flow metadata so exported YAML includes it
    if (!state.meta.platform) {
      state.meta.platform = deviceResult.platform;
    }

    // Initialize app resolver for "open X app" commands
    ui.startSpinner('Loading installed apps…');
    const appResolver = new AppResolver();
    await appResolver.initialize(mcpClient, deviceResult.platform);
    state.appResolver = appResolver;
    ui.stopSpinner();
    ui.printSetupOk('App resolver ready');

    // Surface the effective interaction mode so a silent DOM fallback is never a
    // mystery. `isVisionMode()` (run-yaml-flow) requires BOTH AGENT_MODE=vision AND
    // vision-locate being configured — if vision is requested but not configured,
    // every command quietly runs against the DOM instead.
    const visionLocate = isVisionLocateEnabled();
    if (Config.AGENT_MODE === 'vision' && visionLocate) {
      ui.printSetupOk('Interaction mode: vision');
    } else if (Config.AGENT_MODE === 'vision' && !visionLocate) {
      ui.printWarning(
        'AGENT_MODE=vision is set, but vision-locate is not configured — running in DOM mode. ' +
          'Set GEMINI_API_KEY / STARK_VISION_API_KEY / STARK_VISION_BASE_URL (or LLM_PROVIDER=gemini) to enable vision.'
      );
    } else {
      ui.printSetupOk('Interaction mode: dom');
    }

    const readyContent = [
      `${theme.dim('Type commands to execute on device.')}`,
      '',
      `${theme.dim('Examples:')}`,
      `  ${theme.white('open youtube app')}`,
      `  ${theme.white('click on Search')}`,
      `  ${theme.white('type "hello"')}`,
    ].join('\n');
    console.log();
    printBox(readyContent, {
      title: 'Device connected',
      titleAlignment: 'left',
      borderColor: '#22C55E',
      padding: { left: 2, right: 2, top: 1, bottom: 1 },
    });
    console.log();

    return true;
  } catch (err: any) {
    ui.stopSpinner();
    // Always write to stderr so IDE extensions can see the error
    process.stderr.write(`[playground] Connection failed: ${err?.message ?? err}\n`);
    if (err?.stack) process.stderr.write(`[playground] ${err.stack}\n`);
    ui.printError(`Failed to connect: ${err?.message ?? err}`);
    // AppClaw drives Appium through the appium-mcp subprocess, which it starts itself —
    // there is no separate "Appium server" to launch. A timeout (-32001) almost always
    // means appium-mcp couldn't start/handshake in time (e.g. a cold `npx` download on a
    // global install that doesn't bundle it), NOT that a server is missing.
    const errMsg = String(err?.message ?? err);
    const timedOut = errMsg.includes('-32001') || /timed out/i.test(errMsg);
    if (timedOut) {
      ui.printInfo(
        'AppClaw starts appium-mcp itself — no separate Appium server is needed. The MCP handshake ' +
          'timed out: on a first run appium-mcp may still be downloading via npx. Retry, or reinstall so ' +
          "it's bundled (e.g. npm i -g appclaw@latest). Set MCP_DEBUG=1 to see appium-mcp's startup logs."
      );
    } else {
      ui.printInfo(
        'AppClaw starts appium-mcp itself — no separate Appium server is needed. Make sure a ' +
          'device/emulator is connected. Set MCP_DEBUG=1 to see appium-mcp’s startup logs.'
      );
    }
    console.log();
    return false;
  }
}

// ─── Main REPL ──────────────────────────────────────────

export interface PlaygroundDeviceArgs {
  platform?: 'android' | 'ios' | null;
  deviceType?: 'simulator' | 'real' | null;
  udid?: string | null;
  deviceName?: string | null;
  /**
   * Override directory for bare-filename SDK-test exports (`--export-dir`).
   * Takes precedence over the `EXPORT_DIR` config/env default. Ignored for
   * paths that already include a directory hint or are absolute.
   */
  exportDir?: string | null;
}

/** Stash device args so connectToDevice can use them */
let _deviceArgs: PlaygroundDeviceArgs = {};

/**
 * JSON-mode playground — reads commands from stdin (one per line),
 * emits NDJSON events to stdout. Used by IDE extensions.
 */
export async function runPlaygroundJson(deviceArgs?: PlaygroundDeviceArgs): Promise<void> {
  if (deviceArgs) _deviceArgs = deviceArgs;

  const { emitJson } = await import('../json-emitter.js');

  let connectError: string | undefined;
  try {
    const connected = await connectToDevice();
    if (!connected) {
      connectError = 'connectToDevice returned false';
    }
  } catch (err: any) {
    connectError = err?.message ?? String(err);
  }

  if (connectError) {
    emitJson({ event: 'error', data: { message: `Failed to connect: ${connectError}` } });
    process.exit(1);
  }

  emitJson({ event: 'connected', data: { transport: 'stdio' } });
  emitJson({ event: 'device_ready', data: { platform: _resolvedPlatform } });

  // Graceful shutdown on SIGTERM (sent by VS Code extension bridge.stop())
  const gracefulShutdown = async () => {
    await cleanup();
    emitJson({ event: 'done', data: { success: true, totalSteps: state.steps.length } });
    process.exit(0);
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  if (process.stdin.isPaused()) process.stdin.resume();

  const rl = readline.createInterface({ input: process.stdin });
  let processing = false;

  rl.on('line', async (input: string) => {
    const line = input.trim();
    if (!line) return;

    if (processing) {
      emitJson({ event: 'error', data: { message: 'Still processing previous command' } });
      return;
    }

    processing = true;

    // Slash commands
    if (line.startsWith('/')) {
      if (line === '/quit' || line === '/exit' || line === '/q') {
        await cleanup();
        emitJson({ event: 'done', data: { success: true, totalSteps: state.steps.length } });
        rl.close();
        processing = false;
        return;
      }
      if (line === '/yaml') {
        if (state.steps.length === 0) {
          emitJson({
            event: 'flow_step',
            data: {
              step: 0,
              total: 0,
              kind: 'yaml',
              target: 'No steps to preview',
              status: 'failed',
            },
          });
        } else {
          const yamlStr = buildYamlString();
          emitJson({
            event: 'flow_step',
            data: {
              step: state.steps.length,
              total: state.steps.length,
              kind: 'yaml',
              target: yamlStr,
              status: 'passed',
            },
          });
        }
        processing = false;
        return;
      }
      if (line.startsWith('/export')) {
        const arg = line.slice(7).trim();
        const filename = arg || `flow-${Date.now()}.test.ts`;
        const asSdkTest = isSdkTestFilename(filename);
        const filepath = resolvePlaygroundExportPath(filename, asSdkTest);
        if (state.steps.length === 0) {
          emitJson({
            event: 'flow_step',
            data: {
              step: 0,
              total: 0,
              kind: 'export',
              target: 'No steps to export',
              status: 'failed',
            },
          });
        } else {
          const body = asSdkTest ? buildSdkTestString() : buildYamlString();
          mkdirSync(path.dirname(filepath), { recursive: true });
          writeFileSync(filepath, body, 'utf-8');
          emitJson({
            event: 'flow_step',
            data: {
              step: state.steps.length,
              total: state.steps.length,
              kind: 'export',
              target: filepath,
              status: 'passed',
            },
          });
        }
        processing = false;
        return;
      }
      if (line === '/clear') {
        state.steps.length = 0;
        state.meta = {};
        emitJson({
          event: 'flow_step',
          data: { step: 0, total: 0, kind: 'clear', target: 'All steps cleared', status: 'passed' },
        });
        processing = false;
        return;
      }
      if (line === '/undo') {
        if (state.steps.length === 0) {
          emitJson({
            event: 'flow_step',
            data: { step: 0, total: 0, kind: 'undo', target: 'Nothing to undo', status: 'failed' },
          });
        } else {
          const removed = state.steps.pop()!;
          emitJson({
            event: 'flow_step',
            data: {
              step: state.steps.length,
              total: state.steps.length,
              kind: 'undo',
              target: removed.verbatim ?? removed.kind,
              status: 'passed',
            },
          });
        }
        processing = false;
        return;
      }
      if (line === '/list') {
        const stepsInfo = state.steps.map((s, i) => `${i + 1}. ${s.verbatim ?? s.kind}`).join('\n');
        emitJson({
          event: 'flow_step',
          data: {
            step: state.steps.length,
            total: state.steps.length,
            kind: 'list',
            target: stepsInfo || 'No steps yet',
            status: state.steps.length > 0 ? 'passed' : 'failed',
          },
        });
        processing = false;
        return;
      }
      // Unknown slash command
      emitJson({
        event: 'flow_step',
        data: {
          step: 0,
          total: 0,
          kind: 'info',
          target: `Unknown command: ${line}. Available: /yaml /export /list /undo /clear /quit`,
          status: 'failed',
        },
      });
      processing = false;
      return;
    }

    const stepNum = state.steps.length + 1;

    // ── Per-line execution (JSON mode) ──
    //
    // Same pipeline as the interactive REPL — both delegate to runOneInstruction()
    // so a fix to the instruction pipeline applies to all surfaces at once.
    // Only the IO layer (emit JSON event vs print to terminal) differs here.
    if (!state.mcp) {
      emitJson({
        event: 'step',
        data: {
          step: stepNum,
          action: 'error',
          target: line,
          success: false,
          message: 'Not connected to device',
        },
      });
      processing = false;
      return;
    }

    // Early-outs for bookkeeping-only steps that don't need device execution.
    const earlyParse = tryParseNaturalFlowLine(line);
    if (earlyParse?.kind === 'done') {
      state.steps.push(earlyParse);
      emitJson({
        event: 'step',
        data: { step: stepNum, action: 'done', target: line, success: true, message: 'recorded' },
      });
      processing = false;
      return;
    }
    if (earlyParse?.kind === 'getInfo') {
      const infoAnswer = await handleGetInfo(earlyParse.query);
      emitJson({
        event: 'step',
        data: {
          step: stepNum,
          action: 'getInfo',
          target: line,
          success: true,
          message: infoAnswer || 'No answer',
        },
      });
      processing = false;
      return;
    }

    let outcome;
    try {
      outcome = await runOneInstruction(state.mcp, line, {
        appResolver: state.appResolver ?? undefined,
        minMatchScore: MIN_MATCH_SCORE,
      });
    } catch (err: any) {
      emitJson({
        event: 'step',
        data: {
          step: stepNum,
          action: 'error',
          target: line,
          success: false,
          message: err?.message ?? String(err),
        },
      });
      processing = false;
      return;
    }

    if (outcome.isGetInfo) {
      emitJson({
        event: 'step',
        data: {
          step: stepNum,
          action: 'getInfo',
          target: line,
          success: true,
          message: outcome.getInfoAnswer || outcome.result.message,
        },
      });
      processing = false;
      return;
    }
    if (outcome.step.kind === 'getInfo') {
      const infoAnswer = await handleGetInfo(outcome.step.query);
      emitJson({
        event: 'step',
        data: {
          step: stepNum,
          action: 'getInfo',
          target: line,
          success: true,
          message: infoAnswer || 'No answer',
        },
      });
      processing = false;
      return;
    }
    if (outcome.step.kind === 'done') {
      state.steps.push(outcome.step);
      emitJson({
        event: 'step',
        data: { step: stepNum, action: 'done', target: line, success: true, message: 'recorded' },
      });
      processing = false;
      return;
    }

    if (outcome.result.success) {
      state.steps.push(outcome.step);
    }
    const suggestion =
      !outcome.result.success && outcome.step.kind === 'tap' && outcome.closestMatch
        ? `Closest match: "${outcome.closestMatch}". Try: tap on ${outcome.closestMatch}`
        : null;
    emitJson({
      event: 'step',
      data: {
        step: stepNum,
        action: outcome.step.kind,
        target: line,
        success: outcome.result.success,
        message: suggestion ? `${outcome.result.message}\n${suggestion}` : outcome.result.message,
      },
    });

    processing = false;
  });

  rl.on('close', () => {
    process.exit(0);
  });

  return new Promise((resolve) => {
    rl.on('close', resolve);
  });
}

export async function runPlayground(deviceArgs?: PlaygroundDeviceArgs): Promise<void> {
  if (deviceArgs) _deviceArgs = deviceArgs;
  printPlaygroundHeader();

  // If no platform specified, prompt the user before connecting
  if (!_deviceArgs.platform) {
    const { promptPlatformInline } = await import('../device/platform-picker.js');
    const picked = await promptPlatformInline();
    if (picked) _deviceArgs.platform = picked;
  }

  // Connect to device first
  const connected = await connectToDevice();
  if (!connected) {
    process.exit(1);
  }

  // Ensure stdin is flowing before creating the REPL readline.
  // Prior device-setup steps (spinners, MCP calls) can leave stdin paused.
  if (process.stdin.isPaused()) process.stdin.resume();

  // ── Ink REPL shell on interactive TTYs (pinned prompt, scrolling output) ──
  const useInk =
    !!process.stdout.isTTY && !!process.stdin.isTTY && process.env.APPCLAW_TUI !== 'off';
  if (useInk) {
    const { runPlaygroundInk } = await import('../ui/ink/playground-runner.js');
    const cfg = loadConfig();
    await runPlaygroundInk({
      info: {
        platform: _resolvedPlatform,
        app: state.meta.appId,
        model: cfg.LLM_MODEL || DEFAULT_MODELS[cfg.LLM_PROVIDER] || 'model',
        mode: cfg.AGENT_MODE,
        transport: cfg.MCP_TRANSPORT,
      },
      onCommand: (line: string) => Promise.resolve(processLine(line)),
      onQuit: cleanup,
      getStepCount: () => state.steps.length,
    });
    console.log(`\n  ${theme.dim('Goodbye!')}\n`);
    return;
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

  rl.on('line', async (input: string) => {
    const line = input.trim();

    if (!line) {
      prompt();
      return;
    }

    // Prevent overlapping commands
    if (processing) {
      console.log(`  ${theme.dim('Please wait for the current command to finish…')}`);
      return;
    }

    // Quit
    if (line === '/quit' || line === '/exit' || line === '/q') {
      if (state.steps.length > 0) {
        console.log();
        console.log(
          `  ${theme.warn('!')} ${state.steps.length} step${state.steps.length === 1 ? '' : 's'} not exported.`
        );
        console.log(
          `  ${theme.dim('Use')} ${theme.info('/export <file>')} ${theme.dim('to save, or type')} ${theme.info('/quit')} ${theme.dim('again to discard.')}`
        );
        console.log();
        rl.once('line', async (confirm: string) => {
          const c = confirm.trim();
          if (c === '/quit' || c === '/exit' || c === '/q' || c === 'y' || c === 'yes') {
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

  rl.on('close', () => {
    console.log(`\n  ${theme.dim('Goodbye!')}\n`);
  });

  return new Promise((resolve) => {
    rl.on('close', resolve);
  });
}

async function cleanup(): Promise<void> {
  if (state.mcp) {
    try {
      await state.mcp.callTool('appium_session_management', { action: 'delete' });
    } catch {
      /* ignore — session may already be gone */
    }
    try {
      await state.mcp.close();
    } catch {
      /* ignore */
    }
  }
}

// ─── Screen queries (via vision getInfo) ─────────────

async function handleGetInfo(query: string): Promise<string | null> {
  if (!state.mcp) {
    console.log(`  ${theme.error('✗')} Not connected to device`);
    return null;
  }

  try {
    ui.startSpinner('Analyzing screen', query);
    const { screenshot } = await import('../mcp/tools.js');
    const imageBase64 = await screenshot(state.mcp);
    if (!imageBase64) {
      ui.stopSpinner();
      console.log(`  ${theme.error('✗')} Failed to capture screenshot`);
      return null;
    }

    const {
      getStarkVisionApiKey,
      getStarkVisionBaseUrl,
      getStarkVisionCoordinateOrder,
      getStarkVisionModel,
    } = await import('../vision/locate-enabled.js');
    const apiKey = getStarkVisionApiKey();
    const baseUrl = getStarkVisionBaseUrl();
    if (!apiKey && !baseUrl) {
      ui.stopSpinner();
      console.log(
        `  ${theme.error('✗')} getInfo requires vision (GEMINI_API_KEY or STARK_VISION_BASE_URL)`
      );
      return null;
    }

    const { default: starkVision } = await import('df-vision');
    const { StarkVisionClient } = starkVision;
    const client = new StarkVisionClient({
      apiKey: apiKey || 'local',
      model: getStarkVisionModel(),
      disableThinking: true,
      ...(baseUrl && { baseUrl }),
      ...(baseUrl && { coordinateOrder: getStarkVisionCoordinateOrder() }),
    });
    const response = await client.getElementInfo(imageBase64, query, true);

    let answer: string;
    let explanation: string | undefined;
    try {
      const parsed = JSON.parse(response.replace(/(^```json\s*|```\s*$)/g, '').trim());
      answer = parsed.answer || response;
      explanation = parsed.explanation;
    } catch {
      answer = response;
    }

    ui.stopSpinner();
    console.log();
    const ansContent = explanation ? `${answer}\n\n${theme.dim(explanation)}` : answer;
    printPanel({ title: 'Answer', content: ansContent });
    console.log();
    return answer;
  } catch (err: any) {
    ui.stopSpinner();
    console.log(
      `  ${theme.error('✗')} Failed to get info: ${theme.error(err?.message ?? String(err))}`
    );
    return null;
  }
}

async function processLine(line: string): Promise<void> {
  // Slash commands
  if (line.startsWith('/')) {
    const spaceIdx = line.indexOf(' ');
    const cmd = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const arg = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);

    const handler = COMMANDS[cmd];
    if (handler) {
      await handler.run(arg);
      return;
    }
    console.log(
      `  ${theme.error('✗')} Unknown command: ${theme.dim(cmd)} — type ${theme.info('/help')}`
    );
    return;
  }

  // ── Per-line execution ───────────────────────────────────
  //
  // Pipeline (vision-first → regex → LLM → executeStep) lives in
  // src/flow/run-instruction.ts so the SDK and playground stay in lockstep.
  // Two early-outs for bookkeeping-only step kinds that don't need to touch
  // the device (matches the playground's historical behaviour):
  //   - `done`    → just records the step, no execution
  //   - `getInfo` → routed to handleGetInfo (a separate vision call)
  if (!state.mcp) {
    console.log(`  ${theme.error('✗')} Not connected to device`);
    return;
  }
  const earlyParse = tryParseNaturalFlowLine(line);
  if (earlyParse?.kind === 'done') {
    const stepNum = state.steps.length + 1;
    state.steps.push(earlyParse);
    printStepSuccess(stepNum, earlyParse, 'recorded');
    return;
  }
  if (earlyParse?.kind === 'getInfo') {
    await handleGetInfo(earlyParse.query);
    return;
  }

  ui.startSpinner('Executing', line);
  resetVisionTokens();
  let outcome;
  const t0 = performance.now();
  try {
    outcome = await runOneInstruction(state.mcp, line, {
      appResolver: state.appResolver ?? undefined,
      minMatchScore: MIN_MATCH_SCORE,
    });
  } catch (err: any) {
    ui.stopSpinner();
    console.log(`  ${theme.error('✗')} ${theme.dim(`Failed: ${err?.message ?? String(err)}`)}`);
    console.log(
      `    ${theme.dim('Type')} ${theme.info('/help')} ${theme.dim('to see supported patterns')}`
    );
    return;
  }
  ui.stopSpinner();
  const elapsedMs = Math.round(performance.now() - t0);

  const printVisionTokens = (): void => {
    const vt = getVisionTokens();
    if (vt.totalTokens > 0)
      ui.printStepTokens(
        vt.inputTokens,
        vt.outputTokens,
        vt.cachedTokens || undefined,
        visionCost(vt.inputTokens, vt.outputTokens),
        'vision'
      );
  };

  // Vision detected a "what's on screen" question — show the answer panel
  // and skip the step-recording flow entirely (no device action happened).
  if (outcome.isGetInfo) {
    const ans = outcome.getInfoAnswer || outcome.result.message;
    const ansBody = outcome.getInfoExplanation
      ? `${ans}\n\n${theme.dim(outcome.getInfoExplanation)}`
      : ans;
    console.log();
    printPanel({ title: 'Answer', content: ansBody });
    printVisionTokens();
    console.log();
    return;
  }

  // `done` and `getInfo` resolved via the LLM fallback (not by regex above).
  if (outcome.step.kind === 'getInfo') {
    await handleGetInfo(outcome.step.query);
    return;
  }
  const stepNum = state.steps.length + 1;
  if (outcome.step.kind === 'done') {
    state.steps.push(outcome.step);
    printStepSuccess(stepNum, outcome.step, 'recorded');
    return;
  }

  if (outcome.result.success) {
    state.steps.push(outcome.step);
    printStepSuccess(stepNum, outcome.step, outcome.result.message, elapsedMs);
  } else {
    printStepFail(stepNum, outcome.step, outcome.result.message, elapsedMs);
    if (outcome.step.kind === 'tap' && outcome.closestMatch) {
      console.log(
        `    ${theme.warn(`Closest match: "${outcome.closestMatch}". Try: tap on ${outcome.closestMatch}`)}`
      );
    }
    console.log(`    ${theme.dim('Step not recorded. Fix and try again.')}`);
  }
  printVisionTokens();
}
