/**
 * Shared element-finding utilities with strategy cascade.
 *
 * Used by both the agent loop and the replayer to find elements
 * using multiple locator strategies before giving up.
 */

import type { MCPClient } from '../mcp/types.js';
import { findElement, findElementByVision } from '../mcp/tools.js';
import type { CompactUIElement } from '../perception/types.js';

// ─── AI Vision element helpers ─────────────────────────────

/** Check if a UUID is a vision-generated synthetic element */
export function isAIElement(uuid: string): boolean {
  return uuid.startsWith('ai-element:');
}

/** Parse coordinates from a vision-generated ai-element UUID */
export function parseAIElementCoords(uuid: string): { x: number; y: number } | null {
  if (!isAIElement(uuid)) return null;
  const coordsPart = uuid.replace('ai-element:', '').split(':')[0];
  const [xStr, yStr] = coordsPart.split(',');
  const x = Number(xStr);
  const y = Number(yStr);
  if (isNaN(x) || isNaN(y)) return null;
  return { x, y };
}

/**
 * Tries to find an element by id/text using accessibility id, resource id, then xpath.
 * Returns the Appium element UUID or null.
 */
export async function findByIdStrategies(
  mcp: MCPClient,
  id: string,
  text?: string
): Promise<string | null> {
  // 1. Try accessibility id (content-desc) — but skip empty or generic IDs like "title"
  //    that are shared by many elements (e.g. every row in Android Settings).
  const genericIds = new Set([
    '',
    'title',
    'summary',
    'icon',
    'widget',
    'switch_widget',
    'checkbox',
  ]);
  if (!genericIds.has(id.toLowerCase())) {
    let uuid = await findElement(mcp, 'accessibility id', id).catch(() => null);
    if (uuid) return uuid;

    // 2. Try resource id (Android: com.package:id/name, iOS: name)
    uuid = await findElement(mcp, 'id', id).catch(() => null);
    if (uuid) return uuid;
  }

  // 3. Try finding by visible text (xpath) — useful when id/accessibilityId are generic
  if (text) {
    const escapedText = text.replace(/'/g, "\\'");
    const uuid = await findElement(mcp, 'xpath', `//*[@text='${escapedText}']`).catch(() => null);
    if (uuid) return uuid;
  }

  // 4. Fallback: try generic id anyway if we skipped it
  if (genericIds.has(id.toLowerCase())) {
    let uuid = await findElement(mcp, 'accessibility id', id).catch(() => null);
    if (uuid) return uuid;
    uuid = await findElement(mcp, 'id', id).catch(() => null);
    if (uuid) return uuid;
  }

  return null;
}

/**
 * Find the nearest screen element to the given coordinates.
 */
export function findNearestElement(
  elements: CompactUIElement[],
  coords: [number, number]
): CompactUIElement | null {
  let best: CompactUIElement | null = null;
  let bestDist = Infinity;

  for (const el of elements) {
    if (el.enabled === false) continue;
    const dx = el.center[0] - coords[0];
    const dy = el.center[1] - coords[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  }

  // Only match if within 30px tolerance
  return bestDist <= 30 ? best : null;
}

/**
 * Try to find an element using AI vision (ai_instruction strategy).
 * Returns the synthetic ai-element UUID or null.
 */
export async function findByVision(mcp: MCPClient, description: string): Promise<string | null> {
  try {
    const uuid = await findElementByVision(mcp, description);
    return uuid;
  } catch {
    return null;
  }
}

/**
 * Tries multiple locator strategies in sequence to find an element.
 * Always prefers accessibility id / resource id over xpath.
 * Optionally tries AI vision as a fallback before coordinate tap.
 */
export async function findElementWithFallback(
  mcp: MCPClient,
  screenElements: CompactUIElement[],
  elementId?: string,
  coords?: [number, number],
  useVision?: boolean
): Promise<string | null> {
  // 1. If elementId is provided, try it with all ID strategies
  if (elementId) {
    const uuid = await findByIdStrategies(mcp, elementId);
    if (uuid) return uuid;
  }

  // 2. If coordinates are provided, find the nearest screen element and use its id/text
  if (coords) {
    const nearest = findNearestElement(screenElements, coords);
    if (nearest) {
      if (nearest.id) {
        const uuid = await findByIdStrategies(mcp, nearest.id, nearest.text);
        if (uuid) return uuid;
      }
    }
  }

  // 3. Try AI vision as a fallback if enabled
  if (useVision && elementId) {
    const uuid = await findByVision(mcp, elementId);
    if (uuid) return uuid;
  }

  return null;
}

/**
 * Tap directly at screen coordinates using Appium mobile gestures.
 * Works without finding an element — taps at the exact x,y position.
 */
export async function tapAtCoordinates(mcp: MCPClient, x: number, y: number): Promise<boolean> {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const mcpDebug = process.env.MCP_DEBUG === '1' || process.env.MCP_DEBUG === 'true';

  // Preferred: appium_gesture tap at coordinates (appium-mcp 1.61+)
  try {
    const result = await mcp.callTool('appium_gesture', { action: 'tap', x: ix, y: iy });
    const text = result.content?.map((c: any) => (c.type === 'text' ? c.text : '')).join('') ?? '';
    if (mcpDebug)
      console.log(`        tapAtCoordinates(${ix},${iy}) gesture response: ${text.slice(0, 200)}`);
    if (!text.toLowerCase().includes('error') && !text.toLowerCase().includes('failed')) {
      return true;
    }
  } catch (err) {
    if (mcpDebug)
      console.log(
        `        tapAtCoordinates gesture error: ${err instanceof Error ? err.message : err}`
      );
  }

  // W3C Actions pointer tap
  try {
    await mcp.callTool('appium_perform_actions', {
      actions: [
        {
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: ix, y: iy },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 100 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    return true;
  } catch (err) {
    if (mcpDebug)
      console.log(
        `        tapAtCoordinates w3c error: ${err instanceof Error ? err.message : err}`
      );
  }

  return false;
}
