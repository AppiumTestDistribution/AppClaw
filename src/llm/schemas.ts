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
}
