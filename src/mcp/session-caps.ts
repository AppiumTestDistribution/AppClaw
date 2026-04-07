/**
 * Extra Appium capabilities for create_session (via appium-mcp).
 *
 * Do **not** auto-fill appium:mjpegScreenshotUrl from the port. A guessed URL like
 * http://127.0.0.1:{port} is often wrong (no forward, different path, device-side bind),
 * which yields stale MJPEG frames and bad agent decisions while taps still run.
 *
 * - `appium:mjpegServerPort` only → optional speed path when you set APPIUM_MJPEG_SERVER_PORT.
 * - `appium:mjpegScreenshotUrl` only when APPIUM_MJPEG_SCREENSHOT_URL is set to a URL you
 *   have verified is reachable from the Appium process (adb reverse, correct path, etc.).
 */

import type { AppClawConfig } from '../config.js';

/** Arguments for MCP tool `create_session` on Android. */
export function androidCreateSessionArgs(config: AppClawConfig): {
  platform: 'android';
  capabilities?: Record<string, unknown>;
} {
  const caps: Record<string, unknown> = {};
  const explicitUrl = config.APPIUM_MJPEG_SCREENSHOT_URL.trim();
  const port = config.APPIUM_MJPEG_SERVER_PORT;

  if (port > 0) {
    caps['appium:mjpegServerPort'] = port;
  }
  if (explicitUrl) {
    caps['appium:mjpegScreenshotUrl'] = explicitUrl;
  }

  // NOTE: mjpegScalingFactor is applied AFTER session creation via the settings API
  // (in index.ts) because appium:settings as a capability conflicts with the
  // appium:settings[...] flat-key format that appium-mcp uses, causing it to be ignored.

  if (Object.keys(caps).length === 0) {
    return { platform: 'android' };
  }
  return { platform: 'android', capabilities: caps };
}
