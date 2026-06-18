/**
 * Shared "run one natural-language instruction" pipeline.
 *
 * Both the SDK's `StepRunner` and the playground's per-line handler used to
 * implement this pipeline inline. That duplication was the cause of bugs
 * where one surface (e.g. playground) supported a behaviour that the other
 * (e.g. SDK) silently lacked — most recently, element-targeted swipes.
 *
 * Now both surfaces call `runOneInstruction()` and add only their own UI /
 * state-tracking on top. The pipeline itself lives in exactly one place.
 *
 * Pipeline (in order):
 *
 * 1. **Vision-first** (when `AGENT_MODE=vision` and vision-locate is available):
 *    Call `visionExecute(instruction)` — the LLM gets the screenshot AND the
 *    raw instruction in one call, so it can identify named elements (e.g.
 *    "the first slider") that the regex parser below would strip out.
 *    The `__needs_executeStep__` sentinel from vision-execute is unwrapped here,
 *    so callers never see it.
 *
 * 2. **Regex fallback** — `tryParseNaturalFlowLine()` matches common patterns
 *    without an LLM call (e.g. `"tap login"`, `"swipe right"`, `"wait 2 seconds"`).
 *
 * 3. **LLM fallback** — `resolveNaturalStep()` translates anything the regex
 *    can't handle into a structured FlowStep.
 *
 * 4. **Execute** — `executeStep()` runs the resolved step on device.
 *
 * Goal mode (`runAgent`) is intentionally NOT a caller — it has its own
 * autonomous reasoning loop that calls MCP tools directly.
 */

import type { MCPClient } from '../mcp/types.js';
import type { AppResolver } from '../agent/app-resolver.js';
import type { FlowStep } from './types.js';
import type { ActionResult } from '../llm/schemas.js';
import { Config } from '../config.js';
import { isVisionLocateEnabled } from '../vision/locate-enabled.js';
import { tryParseNaturalFlowLine } from './natural-line.js';
import { resolveNaturalStep } from './llm-parser.js';
import { visionExecute } from './vision-execute.js';
import { executeStep, type FlowTapPollOptions, type ScrollControl } from './run-yaml-flow.js';

/**
 * Minimum matchScore (1-10) for a vision tap to be considered "found". Below
 * this, the tap is rejected even if Gemini returned coordinates. Shared by
 * SDK + playground so both surfaces agree on what counts as a real match.
 */
export const DEFAULT_MIN_MATCH_SCORE = 4;

/** Default tap-retry policy used when callers don't override it. */
export const DEFAULT_TAP_POLL: FlowTapPollOptions = { maxAttempts: 3, intervalMs: 300 };

export interface RunInstructionOptions {
  /** Used by openApp / launchApp to resolve a friendly name to a package ID. */
  appResolver?: AppResolver;
  /** Override the vision matchScore floor. Defaults to DEFAULT_MIN_MATCH_SCORE. */
  minMatchScore?: number;
  /** Override the tap-retry policy. Defaults to DEFAULT_TAP_POLL. */
  tapPoll?: FlowTapPollOptions;
  /** Per-command scroll/swipe overrides (distance + repeat/maxScroll count). */
  scroll?: ScrollControl;
}

export interface RunInstructionResult {
  /** The resolved step that was executed (tap / type / swipe / ...). */
  step: FlowStep;
  /** Success + human-readable message from the execution layer. */
  result: ActionResult;
  /**
   * Vision suggested a similarly-named element when the requested tap missed.
   * Surface this in the UI as a "did you mean" hint. Undefined when not relevant.
   */
  closestMatch?: string;
  /**
   * Whether vision interpreted the instruction as a "what's on screen" question
   * (e.g. `"how many items?"`) rather than an action. When true, the action was
   * NOT executed on device — the LLM's answer is in `getInfoAnswer`.
   */
  isGetInfo?: boolean;
  getInfoAnswer?: string;
  getInfoExplanation?: string;
  /** True when the vision-first branch produced the result. False = regex/LLM fallback. */
  viaVision: boolean;
}

export async function runOneInstruction(
  mcp: MCPClient,
  instruction: string,
  options?: RunInstructionOptions
): Promise<RunInstructionResult> {
  const minMatchScore = options?.minMatchScore ?? DEFAULT_MIN_MATCH_SCORE;
  const tapPoll = options?.tapPoll ?? DEFAULT_TAP_POLL;
  const appResolver = options?.appResolver;
  const scroll = options?.scroll;

  // ── 1. Regex first ─────────────────────────────────────────
  //
  // The regex catches deterministic patterns (wait, swipe direction, back,
  // home, openApp, tap/type/assert with a labelled target, etc.) with zero
  // LLM cost and zero misclassification risk. For element-bearing kinds
  // (tap/type/assert) the regex result's `verbatim` is preserved, and
  // `executeStep` will internally route to `visionExecute` in vision mode
  // (`run-yaml-flow.ts:937`) — so we still get vision-locate for free.
  //
  // Earlier versions of this function ran vision FIRST. That broke simple
  // instructions like `wait for 1 second`, which the vision LLM (Gemini)
  // would mis-classify as `waitUntil "1 second" visible`. The regex catches
  // those correctly, so it should always have first crack.
  const regexStep = tryParseNaturalFlowLine(instruction) ?? undefined;
  if (regexStep) {
    const result = await executeStep(mcp, regexStep, {}, appResolver, tapPoll, undefined, scroll);
    return { step: regexStep, result, viaVision: false };
  }

  // ── 2. Vision next ─────────────────────────────────────────
  //
  // Reached only when the regex couldn't classify the instruction.
  // Vision is the better fallback than `resolveNaturalStep` because it sees
  // the screenshot AND the instruction together — it can resolve named
  // elements that a screen-blind LLM call would silently drop. Example:
  //   "swipe the first slider to the right"
  //   - regex: no match (only matches `swipe <direction>`)
  //   - vision: locates "first slider", element-targeted drag
  //   - resolveNaturalStep: produces `{kind:'swipe', direction:'right'}` only
  //     (drops "first slider", same as the bug we hit pre-vision-first).
  if (Config.AGENT_MODE === 'vision' && isVisionLocateEnabled()) {
    try {
      const vResult = await visionExecute(mcp, instruction, appResolver, undefined, {
        minMatchScore,
      });
      if (vResult) {
        // Vision identified the step but couldn't execute end-to-end — hand off
        // to executeStep with the parsed step. (Internal sentinel from vision-execute.)
        if (vResult.result.message === '__needs_executeStep__') {
          const result = await executeStep(
            mcp,
            vResult.step,
            {},
            appResolver,
            tapPoll,
            undefined,
            scroll
          );
          return { step: vResult.step, result, viaVision: true };
        }
        return {
          step: vResult.step,
          result: vResult.result,
          closestMatch: vResult.closestMatch,
          isGetInfo: vResult.isGetInfo,
          getInfoAnswer: vResult.getInfoAnswer,
          getInfoExplanation: vResult.getInfoExplanation,
          viaVision: true,
        };
      }
    } catch {
      // Vision call crashed — fall through to the deterministic LLM resolver.
    }
  }

  // ── 3. Screen-blind LLM resolver as last resort ─────────────
  // Only reached in DOM mode or when vision is unavailable / crashed.
  const resolved = await resolveNaturalStep(instruction);
  const step = resolved.step;
  const result = await executeStep(mcp, step, {}, appResolver, tapPoll, undefined, scroll);
  return { step, result, viaVision: false };
}
