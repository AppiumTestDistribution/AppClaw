/**
 * Per-step result printer shared by the playground and the SDK.
 *
 * Renders a single executed step in the compact two-line form:
 *
 *   ✓ #1  tap      "search icon"
 *     ●  Tapped "search icon" at [432, 421]
 *
 * Extracted here so callers don't have to reimplement the formatting. The
 * playground uses it for interactive REPL feedback; `src/sdk/step-runner.ts`
 * uses it so SDK consumers see what's happening on the device without having
 * to enable verbose logging.
 */

import chalk from 'chalk';
import { theme } from './terminal.js';
import type { FlowStep } from '../flow/types.js';

/** Short verb word for a step kind — fits in a fixed-width badge. */
export function stepAction(step: FlowStep): string {
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
    case 'zoom':
      return 'zoom';
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

/** Human-readable target description for a step. */
export function stepTarget(step: FlowStep): string {
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
    case 'zoom':
      return `${step.scale >= 1 ? 'in' : 'out'} (${step.scale}x)${step.target ? ` on "${step.target}"` : ''}`;
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

/**
 * Print one step's result in the two-line compact form used by the playground
 * and the SDK. Goes to stdout — no spinners, no progress bars, safe for CI logs.
 */
export function printStepResult(
  stepNum: number,
  step: FlowStep,
  success: boolean,
  message: string
): void {
  const action = stepAction(step);
  const target = stepTarget(step);
  const icon = success ? theme.success('✓') : theme.error('✗');
  const actionBadge = success
    ? chalk.bgHex('#7C6FFF').white.bold(` ${action} `)
    : chalk.bgRed.white.bold(` ${action} `);
  const statusDot = success ? chalk.green('●') : chalk.red('●');

  console.log(`  ${icon} ${theme.dim(`#${stepNum}`)} ${actionBadge} ${theme.white(target)}`);
  if (message) {
    console.log(`    ${statusDot} ${success ? theme.success(message) : theme.error(message)}`);
  }
}
