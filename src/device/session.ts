/**
 * Unified session creation for Android and iOS.
 *
 * Replaces the old androidCreateSessionArgs() callsites with a single
 * function that builds the right capabilities for each platform.
 */

import type { MCPClient } from '../mcp/types.js';
import type { AppClawConfig } from '../config.js';
import type { Platform, DeviceType } from '../index.js';
import { extractText } from '../mcp/tools.js';
import { setDeviceScreenSize, setDevicePlatform } from '../vision/window-size.js';
import { SessionScopedMCPClient } from '../mcp/session-client.js';
import * as ui from '../ui/terminal.js';

export interface SessionResult {
  platform: Platform;
  sessionText: string;
  sessionId: string;
  /** Session-scoped MCP wrapper — injects sessionId into every tool call. */
  scopedMcp: MCPClient;
}

/**
 * Create an Appium session for the given platform.
 * Builds platform-specific capabilities and calls create_session via MCP.
 *
 * @param extraCaps - Additional capabilities merged on top of defaults.
 *   Used for parallel runs to assign unique ports:
 *   - Android: `appium:systemPort`, `appium:mjpegServerPort`
 *   - iOS: `appium:wdaLocalPort`
 */
export async function createPlatformSession(
  mcp: MCPClient,
  config: AppClawConfig,
  platform: Platform,
  _deviceType?: DeviceType,
  extraCaps?: Record<string, unknown>
): Promise<SessionResult> {
  ui.startSpinner('Creating Appium session...');

  const args: Record<string, unknown> = { platform };

  // Add platform-specific capabilities
  if (platform === 'android') {
    // extraCaps wins over config defaults (e.g. parallel workers override mjpeg/system ports)
    const caps = { ...buildAndroidCapabilities(config), ...extraCaps };
    if (Object.keys(caps).length > 0) {
      args.capabilities = caps;
    }
  } else if (platform === 'ios') {
    // For iOS, appium-mcp handles most capabilities internally (WDA setup, device selection).
    // Only pass extraCaps when provided (e.g. wdaLocalPort for parallel runs).
    if (extraCaps && Object.keys(extraCaps).length > 0) {
      args.capabilities = extraCaps;
    }
  }

  try {
    const sessionResult = await mcp.callTool('create_session', args);
    const resultText = extractText(sessionResult);

    if (resultText.toLowerCase().includes('error') || resultText.toLowerCase().includes('failed')) {
      throw new Error(resultText);
    }

    ui.stopSpinner();
    ui.printSetupOk('Appium session created');

    // Parse the session ID from the response text:
    // "ANDROID session created successfully with ID: abc-123-..."
    const sessionIdMatch = resultText.match(/session created successfully with ID:\s*(\S+)/i);
    const sessionId = sessionIdMatch?.[1] ?? 'session';

    // Wrap with a session-scoped client so all subsequent tool calls target this session
    const scopedMcp = new SessionScopedMCPClient(mcp, sessionId);

    // Set platform + detect screen size via the scoped client (stores under scopedMcp in WeakMap)
    setDevicePlatform(scopedMcp, platform);
    await detectScreenSize(scopedMcp, platform);

    return { platform, sessionText: resultText, sessionId, scopedMcp };
  } catch (err: any) {
    ui.stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      platform === 'android'
        ? 'Make sure a device/emulator is connected: adb devices'
        : 'Make sure the simulator is booted or real device is connected. Check: xcrun simctl list devices';
    ui.printSetupError(`Failed to create Appium session: ${msg}`, hint);
    throw err;
  }
}

/** Build Android-specific session capabilities (MJPEG etc.) */
function buildAndroidCapabilities(config: AppClawConfig): Record<string, unknown> {
  const caps: Record<string, unknown> = {};
  const explicitUrl = config.APPIUM_MJPEG_SCREENSHOT_URL.trim();
  const port = config.APPIUM_MJPEG_SERVER_PORT;

  if (port > 0) {
    caps['appium:mjpegServerPort'] = port;
  }
  if (explicitUrl) {
    caps['appium:mjpegScreenshotUrl'] = explicitUrl;
  }

  return caps;
}

/** Detect device screen size after session creation */
async function detectScreenSize(mcp: MCPClient, platform: Platform): Promise<void> {
  // iOS: try window rect first — returns POINTS (the correct coordinate space for XCUITest)
  if (platform === 'ios') {
    for (const tool of ['appium_get_window_rect', 'appium_get_window_size'] as const) {
      try {
        const result = await mcp.callTool(tool, {});
        const text = extractText(result);
        try {
          const obj = JSON.parse(text);
          const w = Number(obj.width ?? obj.w);
          const h = Number(obj.height ?? obj.h);
          if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            setDeviceScreenSize(mcp, `${Math.round(w)}x${Math.round(h)}`);
            return;
          }
        } catch {
          /* not JSON */
        }
        const dimMatch = text.match(/(\d{2,5})\s*[x×,]\s*(\d{2,5})/);
        if (dimMatch) {
          setDeviceScreenSize(mcp, `${dimMatch[1]}x${dimMatch[2]}`);
          return;
        }
      } catch {
        /* tool not available */
      }
    }
  }

  // Android / fallback: try device info
  try {
    const result = await mcp.callTool('appium_mobile_get_device_info', {});
    const text = extractText(result);

    if (platform === 'android') {
      // Android: realDisplaySize (e.g. "720x1600")
      const sizeMatch = text.match(/realDisplaySize['":\s]+(\d+x\d+)/i);
      if (sizeMatch) {
        setDeviceScreenSize(mcp, sizeMatch[1]);
        return;
      }
    }

    // Try JSON parse for both platforms
    try {
      const info = JSON.parse(text);
      if (info.realDisplaySize) {
        setDeviceScreenSize(mcp, info.realDisplaySize);
      }
    } catch {
      // Not JSON — try generic dimension pattern
      const dimMatch = text.match(/(\d{3,4})x(\d{3,4})/);
      if (dimMatch) {
        setDeviceScreenSize(mcp, `${dimMatch[1]}x${dimMatch[2]}`);
      }
    }
  } catch {
    // Device info not available — getScreenSizeForStark will fall back to screenshot dims
    // with iOS scale factor correction
  }
}
