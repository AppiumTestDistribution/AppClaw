/**
 * Playground — interactive REPL that connects to a real device,
 * executes commands live, and records steps for YAML export.
 *
 * Type natural-language commands (tap, swipe, type, etc.)
 * → each one runs immediately on the device via Appium
 * → accumulated steps can be exported as a YAML flow file.
 */

import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { stringify } from 'yaml';

import { loadConfig, Config } from '../config.js';
import { createMCPClient } from '../mcp/client.js';
import { extractText } from '../mcp/tools.js';
import { setupDevice } from '../device/index.js';
import { AppResolver } from '../agent/app-resolver.js';
import { tryParseNaturalFlowLine } from '../flow/natural-line.js';
import { resolveNaturalStep } from '../flow/llm-parser.js';
import { visionExecute } from '../flow/vision-execute.js';
import { resetVisionTokens, getVisionTokens } from '../vision/vision-token-tracker.js';
import { MODEL_PRICING, DEFAULT_MODELS } from '../constants.js';
import { getStarkVisionModel } from '../vision/locate-enabled.js';
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

import { executeStep, type FlowTapPollOptions } from '../flow/run-yaml-flow.js';

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

/** Short action word for a step kind */
function stepAction(step: FlowStep): string {
  switch (step.kind) {
    case 'launchApp':
      return 'launch';
    case 'openApp':
      return 'open';
    case 'tap':
      return 'tap';
    case 'longPress':
      return 'longpress';
    case 'type':
      return 'type';
    case 'swipe':
      return 'swipe';
    case 'wait':
      return 'wait';
    case 'waitUntil':
      return 'wait';
    case 'enter':
      return 'enter';
    case 'back':
      return 'back';
    case 'home':
      return 'home';
    case 'assert':
      return 'assert';
    case 'scrollAssert':
      return 'scroll';
    case 'drag':
      return 'drag';
    case 'getInfo':
      return 'info';
    case 'done':
      return 'done';
  }
}

/** Target description for a step */
function stepTarget(step: FlowStep): string {
  switch (step.kind) {
    case 'launchApp':
      return 'app';
    case 'openApp':
      return step.query;
    case 'tap':
      return `"${step.label}"`;
    case 'longPress':
      return `"${step.label}"${step.duration != null ? ` (${step.duration}ms)` : ''}`;
    case 'type':
      return `"${step.text}"${step.target ? ` → ${step.target}` : ''}`;
    case 'swipe':
      return step.direction;
    case 'wait':
      return `${step.seconds}s`;
    case 'waitUntil':
      if (step.condition === 'screenLoaded') return `screen loaded (${step.timeoutSeconds}s)`;
      if (step.condition === 'gone') return `"${step.text}" gone (${step.timeoutSeconds}s)`;
      return `"${step.text}" visible (${step.timeoutSeconds}s)`;
    case 'enter':
      return '';
    case 'back':
      return '';
    case 'home':
      return '';
    case 'assert':
      return `"${step.text}"`;
    case 'scrollAssert':
      return `"${step.text}" ${step.direction} ×${step.maxScrolls}`;
    case 'drag':
      return `"${step.from}" → "${step.to}"`;
    case 'getInfo':
      return `"${step.query}"`;
    case 'done':
      return step.message ?? '';
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
    case 'tap':
      return 'tapping the screen…';
    case 'longPress':
      return 'long-pressing the screen…';
    case 'type':
      return 'typing into the field…';
    case 'swipe':
      return 'swiping the screen…';
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

function printStepResult(stepNum: number, step: FlowStep, success: boolean, message: string): void {
  const action = stepAction(step);
  const target = stepTarget(step);
  const icon = success ? theme.success('✓') : theme.error('✗');

  const actionBadge = success
    ? chalk.bgHex('#7C6FFF').white.bold(` ${action} `)
    : chalk.bgRed.white.bold(` ${action} `);

  const statusDot = success ? chalk.green('●') : chalk.red('●');

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

/**
 * Minimum matchScore (1-10) required to execute a tap in the playground.
 * Below this threshold, vision found a loose match — show suggestion but don't execute.
 */
const MIN_MATCH_SCORE = 4;

/**
 * Build a helpful suggestion when a tap is not found or matched loosely.
 * Only used as a fallback when vResult.closestMatch is not available.
 */
function buildVisionSuggestion(instruction: string, resolvedLabel: string): string | null {
  if (!resolvedLabel || resolvedLabel === instruction) return null;
  return `Closest match: "${resolvedLabel}". Try: tap on ${resolvedLabel}`;
}

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
    const actionColored = chalk.hex('#6CB6FF').bold(action);
    const statusColored = chalk.green('● pass');

    table.push([
      chalk.hex('#7C6FFF')(`${i + 1}`),
      actionColored,
      chalk.white(target),
      statusColored,
    ]);
  }

  console.log();
  console.log(`  ${chalk.hex('#7C6FFF').bold(title)}`);
  console.log(`  ${table.toString().split('\n').join('\n  ')}`);
  console.log();
  console.log(
    `  ${chalk.green('✓')} ${chalk.green.bold(`${state.steps.length}`)} ${chalk.dim(`step${state.steps.length === 1 ? '' : 's'} recorded`)}  ${progressBar(state.steps.length, state.steps.length, 15)}`
  );
  console.log();
}

// ─── Step execution ─────────────────────────────────────

async function runStepOnDevice(step: FlowStep): Promise<{ success: boolean; message: string }> {
  if (!state.mcp) {
    return { success: false, message: 'Not connected to device' };
  }

  const tapPoll: FlowTapPollOptions = { maxAttempts: 3, intervalMs: 300 };
  return executeStep(state.mcp, step, state.meta, state.appResolver ?? undefined, tapPoll);
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
  '/export': {
    desc: 'Export steps to a YAML file (e.g. /export my-flow.yaml)',
    run: (arg: string) => {
      if (state.steps.length === 0) {
        console.log(`\n  ${theme.error('✗')} No steps to export.\n`);
        return;
      }
      const filename = arg.trim() || `flow-${Date.now()}.yaml`;
      const filepath = filename.startsWith('/') ? filename : path.resolve(process.cwd(), filename);
      const yamlStr = buildYamlString();
      writeFileSync(filepath, yamlStr, 'utf-8');
      const exportContent = [
        `${chalk.green.bold(`${state.steps.length}`)} ${chalk.dim('steps exported')}`,
        '',
        `${chalk.dim('File:')} ${chalk.white(filepath)}`,
        `${chalk.dim('Run:')}  ${chalk.cyan(`appclaw --flow ${path.relative(process.cwd(), filepath)}`)}`,
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
      lines: ['open YouTube', 'launch Settings app'],
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
    appGradient('Execute commands live & export as YAML'),
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
  return `\n  ${chalk.hex('#7C6FFF').bold('›')} `;
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
    ui.printInfo('Make sure Appium server is running and a device/emulator is connected.');
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
        const filename = arg || `flow-${Date.now()}.yaml`;
        const filepath = filename.startsWith('/')
          ? filename
          : path.resolve(process.cwd(), filename);
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
          const yamlStr = buildYamlString();
          writeFileSync(filepath, yamlStr, 'utf-8');
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

    // Vision mode execution
    if (state.mcp && Config.AGENT_MODE === 'vision') {
      try {
        const vResult = await visionExecute(state.mcp, line, undefined, undefined, {
          minMatchScore: MIN_MATCH_SCORE,
        });
        if (vResult) {
          if (vResult.isGetInfo) {
            emitJson({
              event: 'step',
              data: {
                step: stepNum,
                action: 'getInfo',
                target: line,
                success: true,
                message: vResult.getInfoAnswer || vResult.result.message,
              },
            });
            processing = false;
            return;
          }
          if (vResult.result.message === '__needs_executeStep__') {
            const execResult = await runStepOnDevice(vResult.step);
            if (execResult.success) {
              state.steps.push(vResult.step);
            }
            emitJson({
              event: 'step',
              data: {
                step: stepNum,
                action: vResult.step.kind,
                target: line,
                success: execResult.success,
                message: execResult.message,
              },
            });
            processing = false;
            return;
          }
          if (vResult.result.success) {
            state.steps.push(vResult.step);
          }
          const suggestion =
            !vResult.result.success && vResult.step.kind === 'tap' && vResult.closestMatch
              ? `Closest match: "${vResult.closestMatch}". Try: tap on ${vResult.closestMatch}`
              : null;
          emitJson({
            event: 'step',
            data: {
              step: stepNum,
              action: vResult.step.kind,
              target: line,
              success: vResult.result.success,
              message: suggestion
                ? `${vResult.result.message}\n${suggestion}`
                : vResult.result.message,
            },
          });
          processing = false;
          return;
        }
      } catch {
        // Fall through to two-call path
      }
    }

    // Two-call fallback: classify → execute
    let parsed: FlowStep;
    try {
      const resolved = await resolveNaturalStep(line);
      parsed = resolved.step;
    } catch (err: any) {
      emitJson({
        event: 'step',
        data: {
          step: stepNum,
          action: 'error',
          target: line,
          success: false,
          message: `Could not classify: ${err?.message ?? String(err)}`,
        },
      });
      processing = false;
      return;
    }

    if (parsed.kind === 'getInfo') {
      const infoAnswer = await handleGetInfo(parsed.query);
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

    if (parsed.kind === 'done') {
      state.steps.push(parsed);
      emitJson({
        event: 'step',
        data: { step: stepNum, action: 'done', target: line, success: true, message: 'recorded' },
      });
      processing = false;
      return;
    }

    try {
      const result = await runStepOnDevice(parsed);
      if (result.success) {
        state.steps.push(parsed);
      }
      emitJson({
        event: 'step',
        data: {
          step: stepNum,
          action: parsed.kind,
          target: line,
          success: result.success,
          message: result.message,
        },
      });
    } catch (err: any) {
      emitJson({
        event: 'step',
        data: {
          step: stepNum,
          action: parsed.kind,
          target: line,
          success: false,
          message: err?.message ?? String(err),
        },
      });
    }

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

  // ── Hybrid single-call path (vision mode) ──
  // In vision mode: screenshot + instruction → one LLM call → classify + locate → execute.
  // Falls back to two-call path (resolveNaturalStep → executeStep) for non-visual instructions.
  if (state.mcp && Config.AGENT_MODE === 'vision') {
    try {
      ui.startSpinner('Executing', line);
      resetVisionTokens();
      const vResult = await visionExecute(state.mcp, line, undefined, undefined, {
        minMatchScore: MIN_MATCH_SCORE,
      });
      ui.stopSpinner();

      if (vResult) {
        if (vResult.isGetInfo) {
          const ans = vResult.getInfoAnswer || vResult.result.message;
          const ansBody = vResult.getInfoExplanation
            ? `${ans}\n\n${theme.dim(vResult.getInfoExplanation)}`
            : ans;
          console.log();
          printPanel({ title: 'Answer', content: ansBody });
          const vt = getVisionTokens();
          if (vt.totalTokens > 0)
            ui.printStepTokens(
              vt.inputTokens,
              vt.outputTokens,
              vt.cachedTokens || undefined,
              visionCost(vt.inputTokens, vt.outputTokens),
              'vision'
            );
          console.log();
          return;
        }

        if (vResult.result.message === '__needs_executeStep__') {
          const stepNum = state.steps.length + 1;
          ui.startSpinner(`[${stepNum}] ${vResult.step.kind}`, spinnerDetail(vResult.step));
          const execResult = await runStepOnDevice(vResult.step);
          ui.stopSpinner();
          if (execResult.success) {
            state.steps.push(vResult.step);
            printStepSuccess(stepNum, vResult.step, execResult.message);
          } else {
            printStepFail(stepNum, vResult.step, execResult.message);
            console.log(`    ${theme.dim('Step not recorded. Fix and try again.')}`);
          }
          const vt = getVisionTokens();
          if (vt.totalTokens > 0)
            ui.printStepTokens(
              vt.inputTokens,
              vt.outputTokens,
              vt.cachedTokens || undefined,
              visionCost(vt.inputTokens, vt.outputTokens),
              'vision'
            );
          return;
        }

        const stepNum = state.steps.length + 1;
        if (vResult.result.success) {
          state.steps.push(vResult.step);
          printStepSuccess(stepNum, vResult.step, vResult.result.message);
        } else {
          const suggestion =
            vResult.step.kind === 'tap' && vResult.closestMatch
              ? `Closest match: "${vResult.closestMatch}". Try: tap on ${vResult.closestMatch}`
              : null;
          printStepFail(stepNum, vResult.step, vResult.result.message);
          if (suggestion) {
            console.log(`    ${theme.warn(suggestion)}`);
          }
          console.log(`    ${theme.dim('Step not recorded. Fix and try again.')}`);
        }
        const vt = getVisionTokens();
        if (vt.totalTokens > 0)
          ui.printStepTokens(
            vt.inputTokens,
            vt.outputTokens,
            vt.cachedTokens || undefined,
            visionCost(vt.inputTokens, vt.outputTokens),
            'vision'
          );
        return;
      }
    } catch (err: any) {
      ui.stopSpinner();
      const errMsg = err?.message ?? String(err);
      console.log(`  ${theme.dim(`Vision shortcut failed (${errMsg}), falling back…`)}`);
    }
  }

  // ── Regex fast path: try parsing without LLM first ──
  const regexParsed = tryParseNaturalFlowLine(line);
  if (regexParsed) {
    const stepNum = state.steps.length + 1;
    if (regexParsed.kind === 'done') {
      state.steps.push(regexParsed);
      printStepSuccess(stepNum, regexParsed, 'recorded');
      return;
    }
    if (regexParsed.kind === 'getInfo') {
      await handleGetInfo(regexParsed.query);
      return;
    }
    ui.startSpinner(`[${stepNum}] ${regexParsed.kind}`, spinnerDetail(regexParsed));
    resetVisionTokens();
    try {
      const result = await runStepOnDevice(regexParsed);
      ui.stopSpinner();
      if (result.success) {
        state.steps.push(regexParsed);
        printStepSuccess(stepNum, regexParsed, result.message);
      } else {
        printStepFail(stepNum, regexParsed, result.message);
        console.log(`    ${theme.dim('Step not recorded. Fix and try again.')}`);
      }
    } catch (err: any) {
      ui.stopSpinner();
      printStepFail(stepNum, regexParsed, err?.message ?? String(err));
      console.log(`    ${theme.dim('Step not recorded. Fix and try again.')}`);
    }
    return;
  }

  // ── Two-call fallback: classify via LLM → execute via step runner ──
  let parsed: FlowStep;
  let classifyUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  try {
    ui.startSpinner('Classifying', line);
    const resolved = await resolveNaturalStep(line);
    parsed = resolved.step;
    classifyUsage = resolved.usage;
    ui.stopSpinner();
  } catch (err: any) {
    ui.stopSpinner();
    console.log(
      `  ${theme.error('✗')} Could not classify: ${theme.dim(err?.message ?? String(err))}`
    );
    console.log(
      `    ${theme.dim('Type')} ${theme.info('/help')} ${theme.dim('to see supported patterns')}`
    );
    return;
  }

  if (parsed.kind === 'getInfo') {
    await handleGetInfo(parsed.query);
    if (classifyUsage && classifyUsage.totalTokens > 0)
      ui.printStepTokens(
        classifyUsage.inputTokens,
        classifyUsage.outputTokens,
        undefined,
        llmCost(classifyUsage.inputTokens, classifyUsage.outputTokens),
        'classify'
      );
    return;
  }

  const stepNum = state.steps.length + 1;

  if (parsed.kind === 'done') {
    state.steps.push(parsed);
    printStepSuccess(stepNum, parsed, 'recorded');
    if (classifyUsage && classifyUsage.totalTokens > 0)
      ui.printStepTokens(
        classifyUsage.inputTokens,
        classifyUsage.outputTokens,
        undefined,
        llmCost(classifyUsage.inputTokens, classifyUsage.outputTokens),
        'classify'
      );
    return;
  }

  // Execute on device
  ui.startSpinner(`[${stepNum}] ${parsed.kind}`, spinnerDetail(parsed));

  resetVisionTokens();
  try {
    const result = await runStepOnDevice(parsed);
    ui.stopSpinner();

    if (result.success) {
      state.steps.push(parsed);
      printStepSuccess(stepNum, parsed, result.message);
    } else {
      printStepFail(stepNum, parsed, result.message);
      console.log(`    ${theme.dim('Step not recorded. Fix and try again.')}`);
    }
    if (classifyUsage && classifyUsage.totalTokens > 0)
      ui.printStepTokens(
        classifyUsage.inputTokens,
        classifyUsage.outputTokens,
        undefined,
        llmCost(classifyUsage.inputTokens, classifyUsage.outputTokens),
        'classify'
      );
    const vt = getVisionTokens();
    if (vt.totalTokens > 0)
      ui.printStepTokens(
        vt.inputTokens,
        vt.outputTokens,
        vt.cachedTokens || undefined,
        visionCost(vt.inputTokens, vt.outputTokens),
        'vision'
      );
  } catch (err: any) {
    ui.stopSpinner();
    printStepFail(stepNum, parsed, err?.message ?? String(err));
    console.log(`    ${theme.dim('Step not recorded. Fix and try again.')}`);
  }
}
