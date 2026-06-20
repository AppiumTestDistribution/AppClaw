/**
 * Resolve screen size for Stark coordinate scaling.
 *
 * Android: Appium W3C Actions expect physical pixel coordinates.
 *   The authoritative source is `realDisplaySize` from device info
 *   (e.g. "720x1600"). We cache it after session creation.
 *
 * iOS: XCUITest W3C Actions expect logical point coordinates (not pixels).
 *   Priority order for the authoritative source:
 *     1. appium_get_window_rect — returns points when available
 *     2. Device model lookup via appium_mobile_device_info — exact per-model values
 *     3. Screenshot pixel dims ÷ scale factor — reliable fallback
 *
 *   appium_get_window_size is NOT used directly for iOS because some Appium
 *   MCP setups return physical pixels ("Width: 1440, Height: 3120") instead
 *   of logical points, making it an unreliable source.
 */

import type { MCPClient, MCPToolResult } from '../mcp/types.js';
import { pngDimensionsFromBase64 } from './png-dimensions.js';
import { getIOSScreenSizeFromModel, extractIOSModelFromDeviceInfo } from './ios-device-map.js';

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
 * Guess the iOS display scale factor from screenshot pixel dimensions.
 *
 * Uses divisibility as the primary signal (most accurate), then falls back
 * to dimension-based thresholds. Handles both iPhones (3x) and iPads (2x).
 */
function guessIOSScaleFactor(pixelWidth: number, pixelHeight: number): number {
  // Check 3x: dimensions divisible by 3 and result is a plausible iOS point size
  if (pixelWidth % 3 === 0 && pixelHeight % 3 === 0) {
    const pw = pixelWidth / 3;
    const ph = pixelHeight / 3;
    // iPhone point range: 280–450 × 480–980; iPad: 700–1100 × 900–1400
    if (pw >= 280 && pw <= 1100 && ph >= 480 && ph <= 1400) return 3;
  }
  // Check 2x: dimensions divisible by 2 and result is a plausible iOS point size
  if (pixelWidth % 2 === 0 && pixelHeight % 2 === 0) {
    const pw = pixelWidth / 2;
    const ph = pixelHeight / 2;
    if (pw >= 280 && pw <= 1100 && ph >= 480 && ph <= 1400) return 2;
  }
  // Dimension-based heuristic as last resort (less reliable for large iPads)
  const maxDim = Math.max(pixelWidth, pixelHeight);
  if (maxDim > 2000) return 3;
  if (maxDim > 1300) return 2;
  return 1;
}

/**
 * For iOS: detect whether `parsed` is in physical pixel space by comparing it
 * to the actual screenshot dimensions. If the ratio is close to 1.0, the tool
 * returned pixels (not logical points). In that case, derive accurate point
 * dimensions from the screenshot using the scale factor.
 *
 * Returns the (possibly corrected) logical point dimensions.
 */
function correctIosToPoints(
  parsed: { width: number; height: number },
  screenshotBase64: string
): { width: number; height: number } {
  const screenshot = pngDimensionsFromBase64(screenshotBase64);
  if (screenshot) {
    // If parsed width is ≥70% of screenshot width, parsed is in pixel space.
    // (Point dimensions are ~1/2 or ~1/3 of screenshot pixel dimensions.)
    if (parsed.width / screenshot.width >= 0.7) {
      // Derive point size from screenshot dimensions (most accurate path)
      const scale = guessIOSScaleFactor(screenshot.width, screenshot.height);
      return {
        width: Math.round(screenshot.width / scale),
        height: Math.round(screenshot.height / scale),
      };
    }
    // Ratio < 0.7 → parsed is already in point space (screenshot is ~2–3× larger)
    return parsed;
  }

  // No valid screenshot — fall back to heuristic scale correction on the parsed value
  const scale = guessIOSScaleFactor(parsed.width, parsed.height);
  if (scale > 1) {
    return { width: Math.round(parsed.width / scale), height: Math.round(parsed.height / scale) };
  }
  return parsed;
}

/**
 * Best-effort screen size from appium-mcp for Stark coordinate scaling.
 *
 * Android: returns physical pixel dimensions (W3C Actions use pixels).
 * iOS: returns logical point dimensions (W3C Actions use points).
 *
 * Resolution priority for iOS:
 *   0. Session cache (set at session creation)
 *   1. appium_get_window_rect / get_window_rect (returns points; corrected if pixels returned)
 *   2. Device model lookup via appium_mobile_device_info (exact per-model point values)
 *   3. Screenshot pixel dimensions ÷ scale factor (always available, very reliable)
 */
export async function getScreenSizeForStark(
  mcp: MCPClient,
  screenshotBase64: string
): Promise<{ width: number; height: number }> {
  // 0. Use cached deviceScreenSize (most reliable — set at session creation)
  const cached = screenSizeCache.get(mcp);
  if (cached) return cached;

  // Determine platform — if not set via setDevicePlatform, try to infer from device info.
  // We intentionally resolve this before the tool-call cascade so that all branching is correct.
  const knownPlatform = platformCache.get(mcp);
  // We'll lazily resolve isIos once we have device info if the platform isn't cached.
  // For now use the cached value (or default to android for the initial tool call order).
  const isIosFromCache = knownPlatform === 'ios';

  // 1. iOS primary: exact logical point dimensions from the hardware model identifier.
  //    This is the most reliable source — no pixel/point ambiguity, no heuristics.
  //    Attempted first so unknown-platform sessions still work correctly once device
  //    info reveals an iOS model identifier.
  try {
    const result = await mcp.callTool('appium_mobile_device_info', {});
    const text = mcpResultText(result);

    // iOS: look up exact screen size from model ID
    const modelId = extractIOSModelFromDeviceInfo(text);
    if (modelId) {
      const size = getIOSScreenSizeFromModel(modelId);
      if (size) {
        if (process.env.APPCLAW_DEBUG === '1' || process.env.APPCLAW_DEBUG === 'true') {
          console.log(
            `        [window-size] iOS model ${modelId} → ${size.width}×${size.height} pts`
          );
        }
        // Also set platform cache if not already set
        if (!knownPlatform) platformCache.set(mcp, 'ios');
        screenSizeCache.set(mcp, size);
        return size;
      }
    }

    // Android: realDisplaySize in physical pixels
    if (!isIosFromCache) {
      const sizeMatch = text.match(/realDisplaySize['":\s]+(\d+)x(\d+)/i);
      if (sizeMatch) {
        const size = { width: parseInt(sizeMatch[1], 10), height: parseInt(sizeMatch[2], 10) };
        screenSizeCache.set(mcp, size);
        return size;
      }
    }
  } catch {
    /* tool missing */
  }

  // Re-read the (possibly now-updated) platform after device info attempt
  const isIos = (platformCache.get(mcp) ?? 'android') === 'ios';

  // 2. Window rect tools — returns POINTS on iOS (but may return pixels on some setups),
  //    PIXELS on Android.
  //    Note: appium_get_window_size is intentionally omitted for iOS because it can
  //    return physical pixel dimensions (e.g. "Width: 1440, Height: 3120"), making it
  //    ambiguous. appium_get_window_rect is more reliable.
  const windowRectTools = isIos
    ? (['appium_get_window_size'] as const)
    : (['appium_get_window_size'] as const);

  for (const name of windowRectTools) {
    try {
      const result = await mcp.callTool(name, {});
      let parsed = tryParseSizeFromText(mcpResultText(result));
      if (parsed) {
        if (isIos) {
          // Some Appium MCP setups return physical pixels even from window_rect.
          // Correct to logical points using screenshot-ratio detection.
          parsed = correctIosToPoints(parsed, screenshotBase64);
        }
        screenSizeCache.set(mcp, parsed);
        return parsed;
      }
    } catch {
      /* tool missing */
    }
  }

  // 3. Screenshot dimensions (last resort — always available)
  const fromImage = pngDimensionsFromBase64(screenshotBase64);
  if (fromImage) {
    // iOS: screenshots are in physical pixels (e.g. 1320×2868 at 3x) but
    // XCUITest W3C Actions expect logical points (e.g. 440×956).
    if (isIos) {
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
