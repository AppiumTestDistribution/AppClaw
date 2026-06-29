/**
 * Shared types for the agent loop.
 *
 * The action decision schema has been replaced by dynamic tool calling —
 * the LLM now calls tools directly instead of returning a flat JSON object.
 * This file retains ActionResult and helpers used across the codebase.
 */

/** Result of executing an action */
export interface ActionResult {
  success: boolean;
  message: string;
  /**
   * True when the element was resolved via the SDK locator cache fast-path
   * instead of today's DOM parse + multi-strategy probe. Optional and additive;
   * propagated up so reports / step printers can surface hit-rate. Undefined
   * for all non-SDK paths and for actions the cache doesn't apply to.
   */
  cacheHit?: boolean;
  /**
   * The settled screen captured right before this action's gesture fired, as a
   * base64 PNG. For a tap this is the surface the tap happened ON (with the
   * target still visible) — the report shows it with the tap dot, instead of the
   * post-navigation destination. Threaded through the return value (not a module
   * global) so concurrent workers in a parallel run never cross screenshots.
   * Undefined unless the report collector enabled capture.
   */
  beforeScreenshot?: string;
}
