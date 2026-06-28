/**
 * Observable store for the runner's live dashboard.
 *
 * Mirrors the agent-loop store pattern (`src/ui/ink/store.ts`): the imperative
 * `Runner` mutates this via the reporter; the Ink tree subscribes through
 * `useSyncExternalStore`. State is replaced immutably on every mutation.
 *
 * Two render streams:
 *   - `staticItems` — completed test rows + the final summary. Rendered into
 *     Ink's <Static>, so they persist in scrollback after the run.
 *   - everything else — the live dashboard (lanes, progress, queue), redrawn
 *     in place each tick.
 */

import type { Device, SuiteResult, TestResult } from '../types.js';

/** One device's current activity. `title` undefined ⇒ idle/between tests. */
export interface LaneState {
  device: Device;
  title?: string;
  startedAt?: number;
  retry: number;
}

/** A row committed to scrollback via <Static>. */
export type StaticItem =
  | { kind: 'notice'; id: number; message: string }
  | {
      kind: 'result';
      id: number;
      title: string;
      device: string;
      status: 'passed' | 'failed';
      ms: number;
      retries: number;
      error?: string;
    }
  | {
      kind: 'summary';
      id: number;
      passed: number;
      failed: number;
      skipped: number;
      ms: number;
      results: TestResult[];
      reportPath?: string;
    };

export interface RunnerUIState {
  phase: 'booting' | 'running' | 'done';
  boot: string;
  platform: string;
  workers: number;
  startedAt: number;
  total: number;
  runnable: number;
  skipped: number;
  files: number;
  retries: number;
  /** Tests pulled from the queue so far (= passed/failed in flight + done). */
  started: number;
  finished: number;
  passed: number;
  failed: number;
  /** Tests that passed but needed ≥1 retry. */
  flaky: number;
  lanes: LaneState[];
  staticItems: StaticItem[];
  suite?: SuiteResult;
}

function initial(): RunnerUIState {
  return {
    phase: 'booting',
    boot: 'Starting…',
    platform: '',
    workers: 0,
    startedAt: Date.now(),
    total: 0,
    runnable: 0,
    skipped: 0,
    files: 0,
    retries: 0,
    started: 0,
    finished: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    lanes: [],
    staticItems: [],
  };
}

let state: RunnerUIState = initial();
const listeners = new Set<() => void>();
let nextId = 1;

function emit(next: RunnerUIState): void {
  state = next;
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): RunnerUIState {
  return state;
}

function laneFor(lanes: LaneState[], udid: string): LaneState | undefined {
  return lanes.find((l) => l.device.udid === udid);
}

export const store = {
  reset(): void {
    emit(initial());
  },

  starting(message: string): void {
    emit({ ...state, phase: 'booting', boot: message });
  },

  notice(message: string): void {
    emit({
      ...state,
      staticItems: [...state.staticItems, { kind: 'notice', id: nextId++, message }],
    });
  },

  runStart(info: {
    platform: string;
    devices: Device[];
    workers: number;
    total: number;
    runnable: number;
    skipped: number;
    files: number;
    retries: number;
  }): void {
    emit({
      ...state,
      phase: 'running',
      startedAt: Date.now(),
      platform: info.platform,
      workers: info.workers,
      total: info.total,
      runnable: info.runnable,
      skipped: info.skipped,
      files: info.files,
      retries: info.retries,
      lanes: info.devices.map((device) => ({ device, retry: 0 })),
    });
  },

  testStart(title: string, device: Device): void {
    const lanes = state.lanes.map((l) =>
      l.device.udid === device.udid ? { ...l, title, startedAt: Date.now(), retry: 0 } : l
    );
    // Device may not be in the lane list (more devices than workers) — add it.
    if (!laneFor(lanes, device.udid)) {
      lanes.push({ device, title, startedAt: Date.now(), retry: 0 });
    }
    emit({ ...state, lanes, started: state.started + 1 });
  },

  testRetry(device: Device, attempt: number): void {
    const lanes = state.lanes.map((l) =>
      l.device.udid === device.udid ? { ...l, retry: attempt, startedAt: Date.now() } : l
    );
    emit({ ...state, lanes });
  },

  testEnd(info: {
    title: string;
    device: Device;
    status: 'passed' | 'failed';
    ms: number;
    retries: number;
    error?: string;
  }): void {
    const lanes = state.lanes.map((l) =>
      l.device.udid === info.device.udid
        ? { ...l, title: undefined, startedAt: undefined, retry: 0 }
        : l
    );
    const item: StaticItem = {
      kind: 'result',
      id: nextId++,
      title: info.title,
      device: info.device.name,
      status: info.status,
      ms: info.ms,
      retries: info.retries,
      error: info.error,
    };
    emit({
      ...state,
      lanes,
      finished: state.finished + 1,
      passed: state.passed + (info.status === 'passed' ? 1 : 0),
      failed: state.failed + (info.status === 'failed' ? 1 : 0),
      flaky: state.flaky + (info.status === 'passed' && info.retries > 0 ? 1 : 0),
      staticItems: [...state.staticItems, item],
    });
  },

  runEnd(suite: SuiteResult, reportPath?: string): void {
    const summary: StaticItem = {
      kind: 'summary',
      id: nextId++,
      passed: suite.passed,
      failed: suite.failed,
      skipped: suite.skipped,
      ms: suite.durationMs,
      results: suite.results,
      reportPath,
    };
    emit({
      ...state,
      phase: 'done',
      suite,
      staticItems: [...state.staticItems, summary],
    });
  },
};
