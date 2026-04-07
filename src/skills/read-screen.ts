/**
 * read_screen skill — scroll through an entire page and collect all visible text.
 *
 * Strategy:
 * 1. Capture current screen text
 * 2. Scroll down
 * 3. Capture new screen text
 * 4. Repeat until no new text appears or max scrolls reached
 * 5. Return all collected text
 */

import type { MCPClient } from '../mcp/types.js';
import { getPageSource } from '../mcp/tools.js';
import type { ActionResult } from '../llm/schemas.js';
import { detectPlatform } from '../perception/screen.js';
import { parseAndroidPageSource } from '../perception/android-parser.js';
import { parseIOSPageSource } from '../perception/ios-parser.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readScreen(mcp: MCPClient, maxScrolls: number = 5): Promise<ActionResult> {
  const allTexts: Set<string> = new Set();
  let prevTextCount = 0;
  let scrollCount = 0;

  try {
    for (let i = 0; i <= maxScrolls; i++) {
      // Get current screen elements
      const pageSource = await getPageSource(mcp);
      const platform = detectPlatform(pageSource);
      const elements =
        platform === 'android'
          ? parseAndroidPageSource(pageSource)
          : parseIOSPageSource(pageSource);

      // Collect all text from elements
      for (const el of elements) {
        if (el.text && el.text.trim()) {
          allTexts.add(el.text.trim());
        }
      }

      // Check if we found new text
      if (allTexts.size === prevTextCount && i > 0) {
        // No new text — we've reached the end
        break;
      }
      prevTextCount = allTexts.size;

      // Scroll down for more content (skip on last iteration)
      if (i < maxScrolls) {
        await mcp.callTool('appium_scroll', { direction: 'down' });
        scrollCount++;
        await sleep(500);
      }
    }

    const collectedText = Array.from(allTexts).join('\n');

    return {
      success: true,
      message: `Collected ${allTexts.size} text items across ${scrollCount} scrolls:\n${collectedText}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `read_screen failed: ${message}` };
  }
}
