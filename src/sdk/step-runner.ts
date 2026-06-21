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
import { runOneInstruction } from '../flow/run-instruction.js';
import type { FlowTapPollOptions, ScrollControl } from '../flow/run-yaml-flow.js';
import type { LocatorCacheCtx } from './locator-cache.js';
import { getCachedScreenSize } from '../vision/window-size.js';
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
      this.collector.addStep({
        index: this.stepIndex,
        kind: step.kind,
        verbatim: instruction,
        phase: 'test',
        status: result.success ? 'passed' : 'failed',
        message: result.message,
        error: result.success ? undefined : result.message,
        tapCoordinates: tapCoords,
        deviceScreenSize: getCachedScreenSize(this.mcp) ?? undefined,
        cacheHit: result.cacheHit,
      });

      // In vision mode, visionExecute captured the pre-action screenshot — use it
      // for the tap dot overlay (same as the YAML flow path).
      const visionShot = lastVisionScreenshot;
      if (visionShot) {
        const dims = pngDimensionsFromBase64(visionShot) ?? undefined;
        if (tapCoords) {
          this.collector.attachBeforeScreenshot(this.stepIndex, visionShot, dims);
        } else {
          this.collector.attachScreenshot(this.stepIndex, visionShot, dims);
        }
      } else {
        // DOM mode or non-visual step — take an after screenshot
        const screenshotB64 = await screenshot(this.mcp).catch(() => null);
        if (screenshotB64) {
          this.collector.attachScreenshot(this.stepIndex, screenshotB64);
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
