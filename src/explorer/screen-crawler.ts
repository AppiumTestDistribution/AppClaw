/**
 * Screen Crawler — explores a mobile app by navigating screens on-device.
 *
 * Builds a graph of screens and transitions by:
 * 1. Capturing the current screen DOM
 * 2. Identifying tappable elements
 * 3. Tapping each element, recording the screen transition
 * 4. Going back and trying the next element
 *
 * The resulting ScreenGraph provides real UI data for flow generation.
 */

import type { MCPClient } from '../mcp/types.js';
import { extractText } from '../mcp/tools.js';
import { getScreenState } from '../perception/screen.js';
import type { CrawledScreen, ScreenGraph, ScreenTransition, TappableElement } from './types.js';
import * as ui from '../ui/terminal.js';

/** Hash a DOM string to create a screen identifier */
function hashScreen(dom: string): string {
  // Simple hash — strip whitespace and use first 64 chars + length
  const normalized = dom.replace(/\s+/g, ' ').trim();
  const prefix = normalized.slice(0, 100);
  return `screen_${prefix.length}_${normalized.length}`;
}

/** Extract tappable elements from trimmed DOM */
function extractTappableElements(dom: string): TappableElement[] {
  const elements: TappableElement[] = [];
  // Match elements with clickable="true" or class containing Button/Tab
  const lines = dom.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Extract text/content-desc and bounds from DOM elements
    const textMatch = trimmed.match(/text="([^"]+)"/);
    const descMatch = trimmed.match(/content-desc="([^"]+)"/);
    const boundsMatch = trimmed.match(/bounds="(\[[^\]]+\]\[[^\]]+\])"/);
    const clickableMatch = trimmed.match(/clickable="true"/);
    const classMatch = trimmed.match(/class="([^"]+)"/);

    const label = textMatch?.[1] || descMatch?.[1];
    if (!label || !clickableMatch) continue;

    // Determine type from class
    let type: TappableElement['type'] = 'other';
    const cls = classMatch?.[1]?.toLowerCase() ?? '';
    if (cls.includes('button')) type = 'button';
    else if (cls.includes('edittext') || cls.includes('input')) type = 'input';
    else if (cls.includes('tab')) type = 'tab';
    else if (cls.includes('image')) type = 'icon';

    elements.push({
      label,
      type,
      bounds: boundsMatch?.[1],
    });
  }

  return elements;
}

/** Extract visible text content from DOM */
function extractVisibleTexts(dom: string): string[] {
  const texts: string[] = [];
  const textMatches = dom.matchAll(/text="([^"]+)"/g);
  for (const match of textMatches) {
    const text = match[1].trim();
    if (text && text.length > 1) {
      texts.push(text);
    }
  }
  return [...new Set(texts)];
}

/** Check if two DOMs represent the same screen */
function isSameScreen(dom1: string, dom2: string): boolean {
  // Compare normalized DOMs — if >80% similar, consider same screen
  const n1 = dom1.replace(/\s+/g, ' ').trim();
  const n2 = dom2.replace(/\s+/g, ' ').trim();
  if (n1 === n2) return true;

  // Quick length check
  const lenRatio = Math.min(n1.length, n2.length) / Math.max(n1.length, n2.length);
  if (lenRatio < 0.5) return false;

  // Compare first N chars as a heuristic
  const compareLen = Math.min(500, n1.length, n2.length);
  const prefix1 = n1.slice(0, compareLen);
  const prefix2 = n2.slice(0, compareLen);

  let matches = 0;
  for (let i = 0; i < compareLen; i++) {
    if (prefix1[i] === prefix2[i]) matches++;
  }
  return matches / compareLen > 0.8;
}

/** Find the screen ID that matches this DOM, or null */
function findMatchingScreen(dom: string, screens: CrawledScreen[]): string | null {
  for (const screen of screens) {
    if (isSameScreen(dom, screen.dom)) return screen.id;
  }
  return null;
}

export interface CrawlerOptions {
  maxScreens: number;
  maxDepth: number;
  maxElements: number;
  stepDelayMs: number;
}

/**
 * Crawl a mobile app, building a graph of screens and transitions.
 */
export async function crawlApp(
  mcp: MCPClient,
  appId: string | undefined,
  options: CrawlerOptions
): Promise<ScreenGraph> {
  const screens: CrawledScreen[] = [];
  const transitions: ScreenTransition[] = [];
  const visited = new Set<string>();

  // BFS queue: [screenId, depth]
  const queue: Array<{ screenId: string; depth: number }> = [];

  ui.printExplorerPhase('Explore', 'Crawling app screens...');

  // Launch app if appId provided
  if (appId) {
    try {
      await mcp.callTool('appium_app_lifecycle', { action: 'activate', id: appId });
      await sleep(1500);
    } catch {
      ui.printWarning(`Could not launch app ${appId}, using current screen`);
    }
  }

  // Capture initial screen
  const initialState = await getScreenState(mcp, options.maxElements, false, false);
  const initialScreen = createScreenEntry(initialState.dom, screens);
  screens.push(initialScreen);
  queue.push({ screenId: initialScreen.id, depth: 0 });

  ui.printExplorerScreen(
    initialScreen.id,
    initialScreen.tappableElements.length,
    initialScreen.visibleTexts.length
  );

  while (queue.length > 0 && screens.length < options.maxScreens) {
    const { screenId, depth } = queue.shift()!;
    if (visited.has(screenId) || depth >= options.maxDepth) continue;
    visited.add(screenId);

    const screen = screens.find((s) => s.id === screenId);
    if (!screen) continue;

    // Try tapping each tappable element (limit to avoid explosion)
    const elementsToTry = screen.tappableElements
      .filter((e) => e.type !== 'input') // Skip input fields
      .slice(0, 5); // Max 5 elements per screen

    for (const element of elementsToTry) {
      if (screens.length >= options.maxScreens) break;

      try {
        // Tap the element
        ui.printExplorerAction(`tap "${element.label}"`);
        const foundEl = await mcp.callTool('appium_find_element', {
          strategy: 'accessibility id',
          selector: element.label,
        });
        const foundUuid = foundEl.content
          ?.map((c: any) => c.text ?? '')
          .join('')
          .trim();
        if (foundUuid) {
          await mcp.callTool('appium_gesture', { action: 'tap', elementUUID: foundUuid });
        }
        await sleep(options.stepDelayMs);

        // Capture new screen
        const newState = await getScreenState(mcp, options.maxElements, false, false);
        const existingId = findMatchingScreen(newState.dom, screens);

        if (existingId) {
          // Known screen — just record the transition
          transitions.push({
            fromScreen: screenId,
            toScreen: existingId,
            action: 'tap',
            element: element.label,
          });
        } else {
          // New screen discovered!
          const newScreen = createScreenEntry(newState.dom, screens, {
            fromScreen: screenId,
            action: `tap "${element.label}"`,
          });
          screens.push(newScreen);
          transitions.push({
            fromScreen: screenId,
            toScreen: newScreen.id,
            action: 'tap',
            element: element.label,
          });
          queue.push({ screenId: newScreen.id, depth: depth + 1 });

          ui.printExplorerScreen(
            newScreen.id,
            newScreen.tappableElements.length,
            newScreen.visibleTexts.length
          );
        }

        // Navigate back to the original screen
        await mcp.callTool('appium_mobile_press_key', { key: 'BACK' });
        await sleep(options.stepDelayMs);

        // Verify we're back on the expected screen
        const backState = await getScreenState(mcp, options.maxElements, false, false);
        const backId = findMatchingScreen(backState.dom, screens);
        if (backId !== screenId) {
          // Not back on the expected screen — try one more back
          await mcp.callTool('appium_mobile_press_key', { key: 'BACK' });
          await sleep(options.stepDelayMs);
        }
      } catch {
        // Element tap failed — skip it
        continue;
      }
    }
  }

  ui.printExplorerSummary(screens.length, transitions.length);

  return { screens, transitions };
}

function createScreenEntry(
  dom: string,
  existingScreens: CrawledScreen[],
  reachedVia?: { fromScreen: string; action: string }
): CrawledScreen {
  const id = `screen_${existingScreens.length + 1}`;
  return {
    id,
    dom,
    tappableElements: extractTappableElements(dom),
    visibleTexts: extractVisibleTexts(dom),
    reachedVia,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
