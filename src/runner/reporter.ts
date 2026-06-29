/**
 * Reporter seam for the runner.
 *
 * The `Runner` is imperative — it discovers devices, pulls tests off a queue,
 * runs them with retries. Rather than `console.log` inline, it emits lifecycle
 * events to a `RunnerReporter`. Two implementations consume them:
 *
 *   - `PlainReporter`  — line-by-line console output (CI, non-TTY, --reporter
 *     plain). The historical behavior, unchanged.
 *   - the Ink TUI       — a live dashboard (devices, progress, queue). Mounted
 *     only on an interactive TTY; see `tui/activate.tsx`.
 *
 * Keeping the runner behind this interface means the live view is a pure
 * subscriber: the scheduler never imports React, and the plain path never
 * loads Ink.
 */

import { printSummary } from './report.js';
import type { Device, SuiteResult } from './types.js';

/** Run-level facts known once the pool is discovered and the queue is built. */
export interface RunStartInfo {
  platform: string;
  /** Devices that will actually run tests (one lane per worker). */
  devices: Device[];
  workers: number;
  /** Collected tests, including skipped. */
  total: number;
  /** Tests that will execute (total − skipped). */
  runnable: number;
  skipped: number;
  files: number;
  retries: number;
}

/** A test pulled off the queue and handed to a device. */
export interface TestStartInfo {
  title: string;
  device: Device;
  /** Tests still waiting in the queue at the moment this one was pulled. */
  remaining: number;
}

/** A test that finished (after any retries). */
export interface TestEndInfo {
  title: string;
  device: Device;
  status: 'passed' | 'failed';
  durationMs: number;
  /** Retries consumed (0 = passed first try). */
  retries: number;
  error?: string;
}

/**
 * The events the runner emits over a run, in order:
 *   starting* → runStart → (testStart → testRetry* → testEnd)* → runEnd
 */
export interface RunnerReporter {
  /** Boot progress before the pool is known (node spawn, device discovery). */
  starting(message: string): void;
  /** A one-off advisory (e.g. worker count clamped, a device left idle). */
  notice(message: string): void;
  runStart(info: RunStartInfo): void;
  testStart(info: TestStartInfo): void;
  testRetry(info: { title: string; device: Device; attempt: number }): void;
  testEnd(info: TestEndInfo): void;
  runEnd(suite: SuiteResult, reportPath?: string): void;
}

/** Console reporter — the original line-by-line output. */
export class PlainReporter implements RunnerReporter {
  private readonly log = (s: string): void => {
    // eslint-disable-next-line no-console
    console.log(s);
  };

  starting(message: string): void {
    this.log(`  · ${message}`);
  }

  notice(message: string): void {
    this.log(`  ⚠ ${message}`);
  }

  runStart(info: RunStartInfo): void {
    const devs = info.devices.map((d) => d.name).join(', ');
    this.log(
      `\nRunning ${info.runnable} test(s) from ${info.files} file(s) on ` +
        `${info.devices.length} device(s) [${devs}] — ${info.workers} worker(s)\n`
    );
  }

  testStart(): void {
    /* plain output reports on completion, not on start */
  }

  testRetry(info: { title: string; device: Device; attempt: number }): void {
    this.log(`  ↻ ${info.title}  [${info.device.name}] (retry ${info.attempt})`);
  }

  testEnd(info: TestEndInfo): void {
    const icon = info.status === 'passed' ? '✓' : '✗';
    const dur = info.durationMs ? ` ${info.durationMs}ms` : '';
    const retry = info.retries > 0 ? ` (retry ${info.retries})` : '';
    this.log(`  ${icon} ${info.title}  [${info.device.name}]${dur}${retry}`);
  }

  runEnd(suite: SuiteResult, reportPath?: string): void {
    printSummary(suite);
    if (reportPath) this.log(`  report → ${reportPath}\n`);
  }
}
