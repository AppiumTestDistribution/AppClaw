/**
 * find_and_tap skill — scroll to find an element by text, then tap it.
 *
 * Strategy:
 * 1. Try to find the element on current screen
 * 2. If not found, scroll in the specified direction
 * 3. Search again
 * 4. Repeat until found or max scrolls reached
 * 5. Tap the element
 */

import type { MCPClient } from '../mcp/types.js';
import { findElement, findElementByVision, getPageSource } from '../mcp/tools.js';
import type { ActionResult } from '../llm/schemas.js';
import { detectPlatform } from '../perception/screen.js';
import { parseAndroidPageSource } from '../perception/android-parser.js';
import { parseIOSPageSource } from '../perception/ios-parser.js';
import type { UIElement } from '../perception/types.js';
import { isAIElement, parseAIElementCoords, tapAtCoordinates } from '../agent/element-finder.js';
import { isVisionLocateEnabled } from '../vision/locate-enabled.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Find an element matching the query text (case-insensitive partial match) */
function findMatchingElement(elements: UIElement[], query: string): UIElement | null {
  const lower = query.toLowerCase();

  // Exact match first
  const exact = elements.find(
    (el) => el.text.toLowerCase() === lower || el.accessibilityId.toLowerCase() === lower
  );
  if (exact) return exact;

  // Partial match
  const partial = elements.find(
    (el) =>
      el.text.toLowerCase().includes(lower) || el.accessibilityId.toLowerCase().includes(lower)
  );
  if (partial) return partial;

  return null;
}

export async function findAndTap(
  mcp: MCPClient,
  query: string,
  direction: string = 'down',
  maxScrolls: number = 8
): Promise<ActionResult> {
  try {
    // First try: use appium-mcp's scroll_to_element with accessibility id
    try {
      await mcp.callTool('appium_gesture', {
        action: 'scroll_to_element',
        strategy: 'accessibility id',
        selector: query,
        direction,
        maxScrolls,
      });
      const uuid = await findElement(mcp, 'accessibility id', query);
      await mcp.callTool('appium_gesture', { action: 'tap', elementUUID: uuid });
      return { success: true, message: `Found and tapped "${query}" via accessibility ID` };
    } catch {
      // Fall through
    }

    // Second try: resource id strategy
    try {
      await mcp.callTool('appium_gesture', {
        action: 'scroll_to_element',
        strategy: 'id',
        selector: query,
        direction,
        maxScrolls,
      });
      const uuid = await findElement(mcp, 'id', query);
      await mcp.callTool('appium_gesture', { action: 'tap', elementUUID: uuid });
      return { success: true, message: `Found and tapped "${query}" via resource ID` };
    } catch {
      // Fall through
    }

    // Third try: manual scroll + parse page source
    for (let i = 0; i <= maxScrolls; i++) {
      const pageSource = await getPageSource(mcp);
      const platform = detectPlatform(pageSource);
      const elements =
        platform === 'android'
          ? parseAndroidPageSource(pageSource)
          : parseIOSPageSource(pageSource);

      const match = findMatchingElement(elements, query);
      if (match) {
        // Found it — try accessibility id → resource id
        if (match.accessibilityId) {
          try {
            const uuid = await findElement(mcp, 'accessibility id', match.accessibilityId);
            await mcp.callTool('appium_gesture', { action: 'tap', elementUUID: uuid });
            return {
              success: true,
              message: `Found and tapped "${query}" (accessibility id: ${match.accessibilityId})`,
            };
          } catch {
            // Fall through
          }

          try {
            const uuid = await findElement(mcp, 'id', match.accessibilityId);
            await mcp.callTool('appium_gesture', { action: 'tap', elementUUID: uuid });
            return {
              success: true,
              message: `Found and tapped "${query}" (resource id: ${match.accessibilityId})`,
            };
          } catch {
            // Fall through
          }
        }

        return {
          success: false,
          message: `Found "${query}" at [${match.center}] but couldn't tap it via any locator strategy`,
        };
      }

      // Not found — scroll and try again
      if (i < maxScrolls) {
        await mcp.callTool('appium_gesture', { action: 'scroll', direction });
        await sleep(500);
      }
    }

    // Fourth try: AI vision-based finding (if enabled)
    if (isVisionLocateEnabled()) {
      try {
        const visionUuid = await findElementByVision(mcp, query);
        // Pass UUID directly to appium_click — it handles ai-element: UUIDs natively
        await mcp.callTool('appium_gesture', { action: 'tap', elementUUID: visionUuid });
        const coords = parseAIElementCoords(visionUuid);
        const coordInfo = coords ? ` at [${coords.x},${coords.y}]` : '';
        return { success: true, message: `Found and tapped "${query}" via AI vision${coordInfo}` };
      } catch {
        // Vision also failed
      }
    }

    return {
      success: false,
      message: `Could not find "${query}" after ${maxScrolls} scrolls`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `find_and_tap failed: ${message}` };
  }
}
