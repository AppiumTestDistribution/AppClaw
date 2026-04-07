/**
 * Unified screen perception — calls appium_get_page_source via MCP,
 * detects platform, parses XML, filters elements.
 */

import type { MCPClient } from '../mcp/types.js';
import { getPageSource, screenshot } from '../mcp/tools.js';
import type { ScreenState } from './types.js';
import { parseAndroidPageSource } from './android-parser.js';
import { parseIOSPageSource } from './ios-parser.js';
import { filterElements } from './element-filter.js';
import { trimDOM } from './dom-trimmer.js';

/** Detect platform from page source XML content. */
export function detectPlatform(pageSource: string): 'android' | 'ios' {
  if (pageSource.includes('XCUIElementType')) return 'ios';
  return 'android';
}

/** Get the full screen state from the device via MCP tools. */
export async function getScreenState(
  mcp: MCPClient,
  maxElements: number,
  captureScreenshot: boolean = false,
  /** Skip page source fetch — for vision mode where DOM is not needed */
  skipPageSource: boolean = false,
  /** Parse legacy UIElement/CompactUIElement arrays (only needed for recorder) */
  parseLegacyElements: boolean = false
): Promise<ScreenState> {
  // Kick off page source and screenshot in parallel when both are needed
  const pageSourcePromise = !skipPageSource ? getPageSource(mcp) : Promise.resolve('');
  const screenshotPromise = captureScreenshot
    ? screenshot(mcp).catch(() => undefined)
    : Promise.resolve(undefined);

  const [raw, screenshotData] = await Promise.all([pageSourcePromise, screenshotPromise]);

  let elements: import('./types.js').UIElement[] = [];
  let filtered: import('./types.js').CompactUIElement[] = [];
  let dom = '';
  let elementCount = 0;
  let editableCount = 0;
  let platform: 'android' | 'ios' = 'android';

  if (!skipPageSource && raw) {
    platform = detectPlatform(raw);

    const trimResult = trimDOM(raw, platform, maxElements);
    dom = trimResult.xml;
    elementCount = trimResult.elementCount;
    editableCount = trimResult.editableCount;

    // Legacy element parsing — only when recorder needs CompactUIElement[]
    if (parseLegacyElements) {
      elements = platform === 'android' ? parseAndroidPageSource(raw) : parseIOSPageSource(raw);

      filtered = filterElements(elements, maxElements);
    }
  }

  return {
    elements,
    filtered,
    dom,
    elementCount,
    editableCount,
    screenshot: screenshotData ?? undefined,
    platform,
    raw,
  };
}
