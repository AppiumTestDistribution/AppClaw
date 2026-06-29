/**
 * Step runner — executes a single natural-language instruction on device and
 * adapts the result for the SDK's report + console-print conventions.
 *
 * The execution pipeline itself (vision-first → regex → LLM → executeStep)
 * lives in `src/flow/run-instruction.ts` and is shared with the playground.
 * This module's job is only:
 *   - mark the step start on the report collector
 *   - record a step row + screenshot in the report
 *   - print a per-step result line (✓/✗) for SDK users
 *   - convert the engine's ActionResult into the SDK's RunResult shape
 */

import type { MCPClient } from '../mcp/types.js';
import type { RunArtifactCollector } from '../report/writer.js';
import { screenshot } from '../mcp/tools.js';
import { lastVisionScreenshot } from '../flow/vision-execute.js';
import { setPreActionCapture } from '../flow/pre-action-capture.js';
import { runOneInstruction } from '../flow/run-instruction.js';
import type { FlowTapPollOptions, ScrollControl } from '../flow/run-yaml-flow.js';
import type { LocatorCacheCtx } from './locator-cache.js';
import { getCachedScreenSize, getScreenSizeForStark } from '../vision/window-size.js';
import { pngDimensionsFromBase64 } from '../vision/png-dimensions.js';
import { printStepResult } from '../ui/step-printer.js';
import type { AppResolver } from '../agent/app-resolver.js';
import type { RunResult } from './types.js';

function extractCoordinates(message?: string): { x: number; y: number } | undefined {
  if (!message) return undefined;
  const m = message.match(/\[(\d+),\s*(\d+)\]/);
  if (m) return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
  return undefined;
}

export class StepRunner {
  constructor(
    private readonly mcp: MCPClient,
    private readonly collector?: RunArtifactCollector,
    private readonly stepIndex?: number,
    private readonly appResolver?: AppResolver,
    /**
     * When true, suppress the per-step `✓ #N tap "label"` log line.
     * Default false — SDK consumers want to see what's happening on the device,
     * matching the playground's visibility. Pass true to silence (e.g. for noisy
     * CI logs where the test framework already reports per-test outcomes).
     */
    private readonly silent: boolean = false,
    /**
     * Implicit-wait poll budget for element-bearing actions (tap/type/verify/
     * scroll). Threaded into `runOneInstruction` so the target is polled until
     * ready before the action fires. Omit to use the engine default.
     */
    private readonly tapPoll?: FlowTapPollOptions,
    /** Per-command scroll/swipe overrides (distance + repeat/maxScroll count). */
    private readonly scroll?: ScrollControl,
    /**
     * SDK locator cache context. When set, element-bearing actions first try
     * the cached locator before falling back to today's DOM scoring +
     * multi-strategy probe. See `src/sdk/locator-cache.ts`.
     */
    private readonly locatorCache?: LocatorCacheCtx
  ) {}

  async run(instruction: string): Promise<RunResult> {
    if (this.collector && this.stepIndex !== undefined) {
      this.collector.startStep(this.stepIndex);
    }
    // Only pay for a pre-tap screenshot when we're actually recording a report.
    setPreActionCapture(!!this.collector);

    // All "instruction → step → executed" logic lives in runOneInstruction so
    // the SDK and playground stay in lockstep. See src/flow/run-instruction.ts.
    const { step, result } = await runOneInstruction(this.mcp, instruction, {
      appResolver: this.appResolver,
      tapPoll: this.tapPoll,
      scroll: this.scroll,
      locatorCache: this.locatorCache,
    });

    if (this.collector && this.stepIndex !== undefined) {
      const tapCoords = extractCoordinates(result.message);

      // The "tap surface" — the settled screen the action happened ON, captured
      // right before the gesture fired. DOM taps thread it back through the
      // result (race-free across parallel workers); vision mode exposes its
      // analysed screen via the module global. For a tap this is what the report
      // should show, with the dot on the target — NOT the page it navigates to.
      const beforeShot = result.beforeScreenshot ?? lastVisionScreenshot ?? undefined;

      // For a tap, show the before/tap-surface screen so the dot lands on the
      // element. For everything else (assert/type/swipe/wait — no navigation
      // dot), the after-execution screen is the meaningful one.
      const useBefore = !!(tapCoords && beforeShot);
      const shot = useBefore
        ? (beforeShot as string)
        : await screenshot(this.mcp).catch(() => null);
      const dims = shot ? (pngDimensionsFromBase64(shot) ?? undefined) : undefined;

      // Device screen size = the coordinate space tap coords live in. The cache
      // is empty for DOM-mode SDK runs, so fetch it when a tap must be plotted,
      // so the dot scales correctly against the (often downscaled) screenshot.
      let deviceSize = getCachedScreenSize(this.mcp) ?? undefined;
      if (!deviceSize && tapCoords && shot) {
        deviceSize = (await getScreenSizeForStark(this.mcp, shot).catch(() => null)) ?? undefined;
      }

      this.collector.addStep({
        index: this.stepIndex,
        kind: step.kind,
        verbatim: instruction,
        phase: 'test',
        status: result.success ? 'passed' : 'failed',
        message: result.message,
        error: result.success ? undefined : result.message,
        tapCoordinates: tapCoords,
        deviceScreenSize: deviceSize,
        cacheHit: result.cacheHit,
      });

      if (shot) {
        // Tap → the before/tap-surface screen (report displays this with the
        // dot); non-tap → the after-execution result screen.
        if (useBefore) {
          this.collector.attachBeforeScreenshot(this.stepIndex, shot, dims);
        } else {
          this.collector.attachScreenshot(this.stepIndex, shot, dims);
        }
      }
    }

    if (!this.silent) {
      printStepResult(this.stepIndex ?? 1, step, result.success, result.message);
    }

    return {
      success: result.success,
      action: step.kind,
      message: result.message,
    };
  }
}
