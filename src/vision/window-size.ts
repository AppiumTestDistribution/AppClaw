/**
 * Resolve screen size for Stark coordinate scaling.
 *
 * Android: Appium W3C Actions expect physical pixel coordinates.
 *   The authoritative source is `realDisplaySize` from device info
 *   (e.g. "720x1600"). We cache it after session creation.
 *
 * iOS: XCUITest W3C Actions expect logical point coordinates (not pixels).
 *   The authoritative source is `appium_get_window_rect` which returns points.
 *   Screenshot dimensions are in pixels (3x on modern iPhones) and must be
 *   divided by the scale factor before use.
 */

import type { MCPClient, MCPToolResult } from '../mcp/types.js';
import { pngDimensionsFromBase64 } from './png-dimensions.js';

/**
 * Per-MCP-client caches — keyed by the MCPClient instance so parallel workers
 * running on different devices never share or overwrite each other's values.
 */
const screenSizeCache = new WeakMap<MCPClient, { width: number; height: number }>();
const platformCache = new WeakMap<MCPClient, 'android' | 'ios'>();

/**
 * Set the cached screen size from a "WxH" string (e.g. "720x1600").
 * Call after `create_session` so Stark coordinate scaling always uses the right coords.
 */
export function setDeviceScreenSize(mcp: MCPClient, deviceScreenSize: string): void {
  const m = deviceScreenSize.match(/(\d+)\s*x\s*(\d+)/);
  if (m) {
    screenSizeCache.set(mcp, { width: parseInt(m[1], 10), height: parseInt(m[2], 10) });
  }
}

/** Get the cached screen size for this MCP client, or null if not yet determined. */
export function getCachedScreenSize(mcp: MCPClient): { width: number; height: number } | null {
  return screenSizeCache.get(mcp) ?? null;
}

/** Set the current platform so coordinate scaling knows pixel vs point mode. */
export function setDevicePlatform(mcp: MCPClient, platform: 'android' | 'ios'): void {
  platformCache.set(mcp, platform);
}

/** Get the current platform for this MCP client. */
export function getDevicePlatform(mcp: MCPClient): 'android' | 'ios' {
  return platformCache.get(mcp) ?? 'android';
}

function mcpResultText(result: MCPToolResult): string {
  for (const content of result.content) {
    if (content.type === 'text') return content.text;
  }
  return '';
}

function tryParseSizeFromText(text: string): { width: number; height: number } | null {
  const trimmed = text.trim();
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const w = Number(obj.width ?? obj.w);
    const h = Number(obj.height ?? obj.h);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: Math.round(w), height: Math.round(h) };
    }
  } catch {
    /* not JSON */
  }
  // Handle "Width: 1440, Height: 3120" format returned by appium_get_window_size MCP tool
  const wMatch = trimmed.match(/\bwidth[:\s]+(\d+)/i);
  const hMatch = trimmed.match(/\bheight[:\s]+(\d+)/i);
  if (wMatch && hMatch) {
    const w = parseInt(wMatch[1], 10);
    const h = parseInt(hMatch[1], 10);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  // Handle "NxM" or "N,M" compact formats
  const m = trimmed.match(/\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b/);
  if (m) {
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

/**
 * Best-effort screen size from appium-mcp for Stark coordinate scaling.
 *
 * Android: returns physical pixel dimensions (W3C Actions use pixels).
 * iOS: returns logical point dimensions (W3C Actions use points).
 */
export async function getScreenSizeForStark(
  mcp: MCPClient,
  screenshotBase64: string
): Promise<{ width: number; height: number }> {
  // 0. Use cached deviceScreenSize (most reliable — set at session creation)
  const cached = screenSizeCache.get(mcp);
  if (cached) return cached;

  // 1. Standard window rect tools — returns POINTS on iOS, PIXELS on Android
  //    This is the most reliable source for iOS since it gives the correct coordinate space.
  for (const name of [
    'appium_get_window_rect',
    'appium_get_window_size',
    'get_window_rect',
  ] as const) {
    try {
      const result = await mcp.callTool(name, {});
      const parsed = tryParseSizeFromText(mcpResultText(result));
      if (parsed) {
        screenSizeCache.set(mcp, parsed);
        return parsed;
      }
    } catch {
      /* tool missing */
    }
  }

  // 2. appium_mobile_device_info — Android: realDisplaySize in physical pixels
  try {
    const result = await mcp.callTool('appium_mobile_device_info', {});
    const text = mcpResultText(result);
    const sizeMatch = text.match(/realDisplaySize['":\s]+(\d+)x(\d+)/i);
    if (sizeMatch) {
      const size = { width: parseInt(sizeMatch[1], 10), height: parseInt(sizeMatch[2], 10) };
      screenSizeCache.set(mcp, size);
      return size;
    }
  } catch {
    /* tool missing */
  }

  // 3. Screenshot dimensions (last resort)
  const fromImage = pngDimensionsFromBase64(screenshotBase64);
  if (fromImage) {
    // iOS: screenshots are in physical pixels (e.g. 1320x2868 at 3x) but
    // XCUITest W3C Actions expect logical points (e.g. 440x956).
    // Divide by scale factor to get the correct tap coordinate space.
    if ((platformCache.get(mcp) ?? 'android') === 'ios') {
      const scale = guessIOSScaleFactor(fromImage.width, fromImage.height);
      const pointSize = {
        width: Math.round(fromImage.width / scale),
        height: Math.round(fromImage.height / scale),
      };
      screenSizeCache.set(mcp, pointSize);
      return pointSize;
    }
    return fromImage;
  }

  throw new Error(
    'Could not determine screen size for Stark. ' +
      'Ensure appium-mcp exposes device info or window size tools.'
  );
}

/**
 * Guess the iOS display scale factor from screenshot pixel dimensions.
 * Modern iPhones are 3x, older models and iPads may be 2x.
 */
function guessIOSScaleFactor(pixelWidth: number, pixelHeight: number): number {
  // If either dimension divides evenly by 3 and gives a reasonable point size, use 3x
  const maxDim = Math.max(pixelWidth, pixelHeight);
  if (maxDim > 1800) return 3; // Modern iPhones (6+, X, 11-17 Pro etc.)
  if (maxDim > 1200) return 2; // Older iPhones, iPads
  return 1; // Already in points or very low res
}
