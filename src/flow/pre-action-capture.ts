/**
 * Pre-action screenshot capture.
 *
 * For an accurate report, a tap step should show the screen the tap happened
 * ON — with the tap dot on the targeted element — NOT the screen you land on
 * after the tap navigates away. Capturing *after* execution is wrong for
 * navigation taps: "Click on Slider" would show the destination Slider page,
 * not the Samples List where the "Slider" row was tapped, and the dot would
 * land on a meaningless spot.
 *
 * The right moment is *just before the gesture fires* — by then the implicit
 * wait has settled the screen and the target element is located, so the screen
 * is the real tap surface. The DOM tap path (`run-yaml-flow.ts`) calls
 * `capturePreAction()` at that exact point and threads the result back through
 * the `ActionResult` (NOT a module global) so concurrent workers in a parallel
 * run can never cross each other's screenshots.
 *
 * Capturing a screenshot per tap costs latency, so it's a no-op (returns
 * undefined) unless the SDK report collector turns it on via
 * `setPreActionCapture(true)`.
 */

import type { MCPClient } from '../mcp/types.js';
import { screenshot } from '../mcp/tools.js';

let enabled = false;

/** Turn pre-action capture on/off. Off by default (only the report collector enables it). */
export function setPreActionCapture(on: boolean): void {
  enabled = on;
}

/**
 * Capture the current (settled) screen right before an element gesture fires
 * and return it as a base64 PNG. Returns undefined when capture is disabled or
 * the screenshot fails — best-effort, so it can never break the action it
 * precedes.
 */
export async function capturePreAction(mcp: MCPClient): Promise<string | undefined> {
  if (!enabled) return undefined;
  const shot = await screenshot(mcp).catch(() => null);
  return shot ?? undefined;
}
