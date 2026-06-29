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
  /**
   * Logical id for the after-step screenshot (e.g. "steps/step-001.png"). No
   * file is written — the image lives in `screenshot` as base64. Kept as a
   * stable key the report server maps back to the base64 for the live viewer.
   */
  screenshotPath?: string;
  /** Logical id for the BEFORE-action screenshot (tap pointer overlay). */
  beforeScreenshotPath?: string;
  /** After-step screenshot as a base64 data URI (`data:image/png;base64,…`). */
  screenshot?: string;
  /** Before-action screenshot as a base64 data URI. */
  beforeScreenshot?: string;
  /** Coordinates of the element interacted with (for tap/type pointer overlay) */
  tapCoordinates?: { x: number; y: number };
  /** Device screen dimensions in the coordinate system used by tap actions (physical pixels on Android, logical points on iOS) */
  deviceScreenSize?: { width: number; height: number };
  /** Screenshot PNG pixel dimensions */
  screenshotSize?: { width: number; height: number };
  /** Ms elapsed from run startedAt to when this step began executing — used to sync video playback */
  videoOffsetMs?: number;
  /**
   * True when the SDK locator cache served this step's element resolution
   * (bypassed DOM parse + multi-strategy probe). Surfaced in run-manifest.json
   * so users can grep cache hit-rate during rollout. Not yet rendered in HTML —
   * follow-up if it proves useful enough to be a first-class badge.
   */
  cacheHit?: boolean;
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
  /** Device OS version, display-ready ("Android 14" / "iOS 17.2"), if detected */
  deviceVersion?: string;
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
  /**
   * Diagnostic logs captured when the run failed, for the report's failure
   * panel. `appiumMcp` is the appium-mcp server log tail at failure time (the
   * server is shared across parallel workers, so it can interleave sessions).
   * The appclaw-side trace is derived from `steps` by the report, not stored
   * here.
   */
  failureLogs?: {
    appiumMcp?: string;
  };
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
