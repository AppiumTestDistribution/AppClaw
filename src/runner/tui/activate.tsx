/**
 * Mounts the runner dashboard and exposes it as a `RunnerReporter`.
 *
 * The runner calls `activateRunnerTui()` once (on an interactive TTY); the
 * returned `reporter` forwards every lifecycle event into the store, and
 * `cleanup()` unmounts Ink at the end of the run. `patchConsole` stays on so
 * stray `console.log`s from user hooks/fixtures are reprinted above the live
 * box instead of corrupting it.
 */

import React from 'react';
import { render, type Instance } from 'ink';
import { Dashboard } from './Dashboard.js';
import { store } from './store.js';
import type { RunnerReporter } from '../reporter.js';

export function activateRunnerTui(): {
  reporter: RunnerReporter;
  cleanup: () => Promise<void>;
} {
  store.reset();
  let instance: Instance | null = render(<Dashboard />, { patchConsole: true });

  const reporter: RunnerReporter = {
    starting: (message) => store.starting(message),
    notice: (message) => store.notice(message),
    runStart: (info) => store.runStart(info),
    testStart: (info) => store.testStart(info.title, info.device),
    testRetry: (info) => store.testRetry(info.device, info.attempt),
    testEnd: (info) =>
      store.testEnd({
        title: info.title,
        device: info.device,
        status: info.status,
        ms: info.durationMs,
        retries: info.retries,
        error: info.error,
      }),
    runEnd: (suite, reportPath) => store.runEnd(suite, reportPath),
  };

  const cleanup = async (): Promise<void> => {
    if (!instance) return;
    const i = instance;
    instance = null;
    // Let the final summary (appended to <Static>) flush before unmounting.
    await new Promise((r) => setTimeout(r, 60));
    i.unmount();
    // Restore stdin instead of awaiting `waitUntilExit()`: after unmount that
    // promise can stay pending with no live handles, draining the event loop
    // and tripping Node's "unsettled top-level await" warning in bin/appclaw.js.
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {
      /* ignore — stdin may not be a TTY */
    }
  };

  return { reporter, cleanup };
}
