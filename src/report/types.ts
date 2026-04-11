/**
 * Report data types — JSON-on-disk model for flow execution results.
 *
 * No database. Everything is stored as flat JSON files under `.appclaw/runs/`.
 */

import type { FlowPhase, FlowMeta } from '../flow/types.js';

/* ─── Per-step artifact ──────────────────────────────────── */

export type StepStatus = 'passed' | 'failed' | 'skipped';

export interface StepArtifact {
  /** 0-based step index */
  index: number;
  /** Step kind: tap, type, assert, wait, swipe, etc. */
  kind: string;
  /** Original YAML line (natural-language verbatim) */
  verbatim?: string;
  /** Resolved target label (e.g. "Login button", "email field") */
  target?: string;
  /** Execution phase */
  phase: FlowPhase;
  /** Step outcome */
  status: StepStatus;
  /** Duration in ms */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Informational message (e.g. assert text, done message) */
  message?: string;
  /** Relative path to screenshot taken after step (e.g. "steps/step-001.png") */
  screenshotPath?: string;
  /** Relative path to screenshot taken BEFORE the action (for tap pointer overlay) */
  beforeScreenshotPath?: string;
  /** Coordinates of the element interacted with (for tap/type pointer overlay) */
  tapCoordinates?: { x: number; y: number };
  /** Device screen dimensions in the coordinate system used by tap actions (physical pixels on Android, logical points on iOS) */
  deviceScreenSize?: { width: number; height: number };
  /** Screenshot PNG pixel dimensions */
  screenshotSize?: { width: number; height: number };
  /** Ms elapsed from run startedAt to when this step began executing — used to sync video playback */
  videoOffsetMs?: number;
}

/* ─── Run manifest (per-run JSON) ────────────────────────── */

export interface RunManifest {
  /** Unique run ID (timestamp-based: "20260403T143022-abc") */
  runId: string;
  /** Absolute path to the source YAML flow file */
  flowFile: string;
  /** Flow metadata from YAML header */
  meta: FlowMeta;
  /** Execution timestamps */
  startedAt: string;
  finishedAt: string;
  /** Total duration in ms */
  durationMs: number;
  /** Resolved platform */
  platform: 'android' | 'ios';
  /** Device name or UDID (if known) */
  device?: string;
  /** Overall result */
  success: boolean;
  /** Steps executed count */
  stepsExecuted: number;
  /** Total steps count */
  stepsTotal: number;
  /** Step index where failure occurred (0-based) */
  failedAt?: number;
  /** Failure reason */
  reason?: string;
  /** Which phase failed */
  failedPhase?: FlowPhase;
  /** Per-phase results */
  phaseResults?: PhaseResultRecord[];
  /** Per-step artifacts with screenshots */
  steps: StepArtifact[];
  /** Relative path to the screen recording (e.g. "recording.mp4") */
  videoPath?: string;
}

export interface PhaseResultRecord {
  phase: FlowPhase;
  success: boolean;
  stepsExecuted: number;
  stepsTotal: number;
  failedAt?: number;
  reason?: string;
}

/* ─── Run index (global index file) ──────────────────────── */

export interface RunIndexEntry {
  runId: string;
  flowFile: string;
  flowName?: string;
  platform: 'android' | 'ios';
  startedAt: string;
  durationMs: number;
  success: boolean;
  stepsExecuted: number;
  stepsTotal: number;
  failedPhase?: FlowPhase;
  /** Device name (if known) */
  device?: string;
  /** Suite this run belongs to (if part of a parallel or suite run) */
  suiteId?: string;
  /** Human-readable suite name */
  suiteName?: string;
}

export interface SuiteEntry {
  suiteId: string;
  suiteName?: string;
  platform: 'android' | 'ios';
  startedAt: string;
  durationMs: number;
  /** Ordered list of run IDs that belong to this suite */
  runIds: string[];
  passedCount: number;
  failedCount: number;
}

export interface RunIndex {
  schemaVersion: 1;
  generatedAt: string;
  runs: RunIndexEntry[];
  suites?: SuiteEntry[];
}
