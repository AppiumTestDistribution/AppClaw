/**
 * Report writer — persists flow execution results to JSON on disk.
 *
 * Storage layout:
 *   .appclaw/runs/
 *     runs.json              ← global index
 *     <runId>/
 *       manifest.json        ← full run data
 *       steps/
 *         step-000.png       ← screenshot per step
 *         step-001.png
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  RunManifest,
  RunIndex,
  RunIndexEntry,
  SuiteEntry,
  StepArtifact,
  StepStatus,
} from './types.js';
import type { FlowMeta, FlowPhase } from '../flow/types.js';
import type { RunYamlFlowResult } from '../flow/run-yaml-flow.js';

/* ─── Helpers ────────────────────────────────────────────── */

function generateRunId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', 'T').split('.')[0];
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${ts}-${suffix}`;
}

function runsDir(projectRoot: string): string {
  return path.join(projectRoot, '.appclaw', 'runs');
}

function indexPath(projectRoot: string): string {
  return path.join(runsDir(projectRoot), 'runs.json');
}

/* ─── Read / write index ─────────────────────────────────── */

async function readIndex(projectRoot: string): Promise<RunIndex> {
  const p = indexPath(projectRoot);
  try {
    const raw = await fsp.readFile(p, 'utf-8');
    return JSON.parse(raw) as RunIndex;
  } catch {
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), runs: [] };
  }
}

async function writeIndex(projectRoot: string, index: RunIndex): Promise<void> {
  const p = indexPath(projectRoot);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  index.generatedAt = new Date().toISOString();
  await fsp.writeFile(p, JSON.stringify(index, null, 2), 'utf-8');
}

/* ─── Step collector (used during execution) ─────────────── */

export interface StepCollectorEntry {
  index: number;
  kind: string;
  verbatim?: string;
  target?: string;
  phase: FlowPhase;
  status: StepStatus;
  durationMs: number;
  error?: string;
  message?: string;
  /** Base64-encoded PNG screenshot taken AFTER the step (not yet saved to disk) */
  screenshotBase64?: string;
  /** Base64-encoded PNG screenshot taken BEFORE the action (for tap pointer overlay) */
  beforeScreenshotBase64?: string;
  /** Coordinates of the element interacted with */
  tapCoordinates?: { x: number; y: number };
  /** Device screen dimensions (coordinate space for tap) */
  deviceScreenSize?: { width: number; height: number };
  /** Screenshot dimensions at capture time */
  screenshotSize?: { width: number; height: number };
  /** Ms from run start to step start — for accurate video timestamp sync */
  videoOffsetMs?: number;
}

/**
 * Collects per-step data during flow execution.
 * Call `addStep()` from the `onFlowStep` callback, then `finalize()` after the flow completes.
 */
export class RunArtifactCollector {
  readonly runId: string;
  readonly startedAt: string;
  private steps: StepCollectorEntry[] = [];
  private stepTimers = new Map<number, number>();
  private videoBase64: string | undefined;
  private videoFilePath: string | undefined;

  constructor(
    readonly flowFile: string,
    readonly meta: FlowMeta,
    readonly platform: 'android' | 'ios',
    readonly device?: string,
    readonly suiteId?: string,
    readonly suiteName?: string
  ) {
    this.runId = generateRunId();
    this.startedAt = new Date().toISOString();
  }

  /** Mark step as started (for duration tracking). */
  startStep(index: number): void {
    this.stepTimers.set(index, Date.now());
  }

  /** Record a completed step. */
  addStep(entry: Omit<StepCollectorEntry, 'durationMs'> & { durationMs?: number }): void {
    const startTime = this.stepTimers.get(entry.index);
    const durationMs = entry.durationMs ?? (startTime ? Date.now() - startTime : 0);
    const videoOffsetMs = startTime ? startTime - new Date(this.startedAt).getTime() : undefined;
    this.steps.push({ ...entry, durationMs, videoOffsetMs });
    this.stepTimers.delete(entry.index);
  }

  /** Attach a base64 screenshot (after action) to an already-recorded step. */
  attachScreenshot(
    stepIndex: number,
    base64: string,
    dimensions?: { width: number; height: number }
  ): void {
    const step = this.steps.find((s) => s.index === stepIndex);
    if (step) {
      step.screenshotBase64 = base64;
      if (dimensions) step.screenshotSize = dimensions;
    }
  }

  /** Attach the base64-encoded screen recording (MP4) for the whole run. */
  attachVideo(base64: string): void {
    this.videoBase64 = base64;
  }

  /** Attach a screen recording from a file path on disk (will be copied into the run dir). */
  attachVideoFromPath(filePath: string): void {
    this.videoFilePath = filePath;
  }

  /** Attach a "before" screenshot (taken before the action) to a step. */
  attachBeforeScreenshot(
    stepIndex: number,
    base64: string,
    dimensions?: { width: number; height: number }
  ): void {
    const step = this.steps.find((s) => s.index === stepIndex);
    if (step) {
      step.beforeScreenshotBase64 = base64;
      if (dimensions) step.screenshotSize = dimensions;
    }
  }

  /** Write everything to disk and update the global index. */
  async finalize(projectRoot: string, result: RunYamlFlowResult): Promise<string> {
    const finishedAt = new Date().toISOString();
    const durationMs = new Date(finishedAt).getTime() - new Date(this.startedAt).getTime();

    // Create run directory
    const runDir = path.join(runsDir(projectRoot), this.runId);
    const stepsDir = path.join(runDir, 'steps');
    await fsp.mkdir(stepsDir, { recursive: true });

    // Save screenshots and build step artifacts
    const stepArtifacts: StepArtifact[] = [];
    for (const step of this.steps) {
      let screenshotPath: string | undefined;
      let beforeScreenshotPath: string | undefined;
      if (step.screenshotBase64) {
        const filename = `step-${String(step.index).padStart(3, '0')}.png`;
        screenshotPath = `steps/${filename}`;
        const fullPath = path.join(runDir, screenshotPath);
        await fsp.writeFile(fullPath, Buffer.from(step.screenshotBase64, 'base64'));
      }
      if (step.beforeScreenshotBase64) {
        const filename = `step-${String(step.index).padStart(3, '0')}-before.png`;
        beforeScreenshotPath = `steps/${filename}`;
        const fullPath = path.join(runDir, beforeScreenshotPath);
        await fsp.writeFile(fullPath, Buffer.from(step.beforeScreenshotBase64, 'base64'));
      }
      stepArtifacts.push({
        index: step.index,
        kind: step.kind,
        verbatim: step.verbatim,
        target: step.target,
        phase: step.phase,
        status: step.status,
        durationMs: step.durationMs,
        error: step.error,
        message: step.message,
        screenshotPath,
        beforeScreenshotPath,
        tapCoordinates: step.tapCoordinates,
        deviceScreenSize: step.deviceScreenSize,
        screenshotSize: step.screenshotSize,
        videoOffsetMs: step.videoOffsetMs,
      });
    }

    // Save screen recording if captured
    let videoPath: string | undefined;
    if (this.videoBase64) {
      videoPath = 'recording.mp4';
      await fsp.writeFile(path.join(runDir, videoPath), Buffer.from(this.videoBase64, 'base64'));
    } else if (this.videoFilePath) {
      videoPath = 'recording.mp4';
      await fsp.copyFile(this.videoFilePath, path.join(runDir, videoPath));
    }

    // Build manifest
    const manifest: RunManifest = {
      runId: this.runId,
      flowFile: this.flowFile,
      meta: this.meta,
      startedAt: this.startedAt,
      finishedAt,
      durationMs,
      platform: this.platform,
      device: this.device,
      success: result.success,
      stepsExecuted: result.stepsExecuted,
      stepsTotal: result.stepsTotal,
      failedAt: result.failedAt,
      reason: result.reason,
      failedPhase: result.failedPhase,
      phaseResults: result.phaseResults,
      steps: stepArtifacts,
      videoPath,
    };

    // Write manifest
    await fsp.writeFile(
      path.join(runDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    // Update global index
    const index = await readIndex(projectRoot);
    const entry: RunIndexEntry = {
      runId: this.runId,
      flowFile: this.flowFile,
      flowName: this.meta.name,
      platform: this.platform,
      startedAt: this.startedAt,
      durationMs,
      success: result.success,
      stepsExecuted: result.stepsExecuted,
      stepsTotal: result.stepsTotal,
      failedPhase: result.failedPhase,
      device: this.device,
      suiteId: this.suiteId,
      suiteName: this.suiteName,
    };
    // Prepend (newest first)
    index.runs.unshift(entry);
    await writeIndex(projectRoot, index);

    return this.runId;
  }
}

/* ─── Read helpers (used by report server) ───────────────── */

export async function loadRunIndex(projectRoot: string): Promise<RunIndex> {
  return readIndex(projectRoot);
}

export async function loadRunManifest(
  projectRoot: string,
  runId: string
): Promise<RunManifest | null> {
  const manifestPath = path.join(runsDir(projectRoot), runId, 'manifest.json');
  try {
    const raw = await fsp.readFile(manifestPath, 'utf-8');
    return JSON.parse(raw) as RunManifest;
  } catch {
    return null;
  }
}

export function getArtifactPath(projectRoot: string, runId: string, ...segments: string[]): string {
  return path.join(runsDir(projectRoot), runId, ...segments);
}

/** Write (or overwrite) a suite-level aggregate entry in the global index. */
export async function writeSuiteEntry(projectRoot: string, entry: SuiteEntry): Promise<void> {
  const index = await readIndex(projectRoot);
  if (!index.suites) index.suites = [];
  // Replace existing entry for this suiteId if it exists, otherwise prepend
  const existing = index.suites.findIndex((s) => s.suiteId === entry.suiteId);
  if (existing >= 0) {
    index.suites[existing] = entry;
  } else {
    index.suites.unshift(entry);
  }
  await writeIndex(projectRoot, index);
}
