/**
 * Unified session creation for Android and iOS.
 *
 * Replaces the old androidCreateSessionArgs() callsites with a single
 * function that builds the right capabilities for each platform.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MCPClient } from '../mcp/types.js';
import type { AppClawConfig } from '../config.js';
import type { Platform, DeviceType } from '../index.js';
import { extractText } from '../mcp/tools.js';
import { setDeviceScreenSize, setDevicePlatform } from '../vision/window-size.js';
import {
  extractIOSModelFromDeviceInfo,
  getIOSScreenSizeFromModel,
} from '../vision/ios-device-map.js';
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
  // User-supplied capabilities from CAPABILITIES_FILE (if any). Loaded once and
  // merged into whichever session path runs below.
  const fileCaps = loadCapabilitiesFile(config, platform);

  if (config.CLOUD_PROVIDER === 'lambdatest') {
    return createLambdaTestSession(mcp, config, platform, fileCaps);
  }

  ui.startSpinner('Creating Appium session...');

  const args: Record<string, unknown> = { platform };

  // Capability precedence (later wins): config defaults < CAPABILITIES_FILE <
  // extraCaps. extraCaps (parallel ports, pinned udid) must win last so concurrent
  // workers don't collide and device pinning holds even if the file sets the same key.
  if (platform === 'android') {
    const caps = { ...buildAndroidCapabilities(config), ...fileCaps, ...extraCaps };
    if (Object.keys(caps).length > 0) {
      args.capabilities = JSON.stringify(caps);
    }
  } else if (platform === 'ios') {
    // For iOS, appium-mcp handles most capabilities internally (WDA setup, device selection).
    // Merge config-level APP_PATH with the caps file and extraCaps (per-flow app: overrides .env).
    const iosCaps = {
      ...(config.APP_PATH ? { 'appium:app': config.APP_PATH } : {}),
      ...fileCaps,
      ...extraCaps,
    };
    if (Object.keys(iosCaps).length > 0) {
      args.capabilities = JSON.stringify(iosCaps);
    }
  }

  try {
    const sessionResult = await mcp.callTool('appium_session_management', {
      action: 'create',
      ...args,
    });
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

/**
 * Load extra Appium capabilities from CAPABILITIES_FILE (a JSON object), if set.
 * Returns {} when unset. Throws a clear error when the path is set but missing,
 * unreadable, not valid JSON, or not a plain object — fail fast rather than
 * silently ignoring caps the user explicitly asked for.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Accept both:
 *   { "appium:app": "/tmp/app.apk" }
 * and platform-scoped files:
 *   { "android": { "appium:app": "/tmp/app.apk" }, "ios": { ... } }
 *
 * Platform wrapper keys are config metadata, not Appium capabilities. Sending
 * them through to Appium 3 fails W3C validation because "android"/"ios" are
 * unprefixed, non-standard capability names.
 */
export function normalizeCapabilitiesForPlatform(
  parsed: Record<string, unknown>,
  platform: Platform,
  sourceLabel = 'CAPABILITIES_FILE'
): Record<string, unknown> {
  const platformKeys = new Set(['android', 'ios']);
  const sharedKeys = new Set(['common', 'default', 'shared']);
  const hasPlatformSection = 'android' in parsed || 'ios' in parsed;

  if (!hasPlatformSection) return parsed;

  const topLevelCaps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!platformKeys.has(key) && !sharedKeys.has(key)) {
      topLevelCaps[key] = value;
    }
  }

  const sharedCaps: Record<string, unknown> = {};
  for (const key of sharedKeys) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      throw new Error(`${sourceLabel} field "${key}" must be a JSON object of capabilities`);
    }
    Object.assign(sharedCaps, value);
  }

  const platformCaps = parsed[platform];
  if (platformCaps === undefined) {
    return { ...topLevelCaps, ...sharedCaps };
  }
  if (!isPlainObject(platformCaps)) {
    throw new Error(`${sourceLabel} field "${platform}" must be a JSON object of capabilities`);
  }

  return { ...topLevelCaps, ...sharedCaps, ...platformCaps };
}

function loadCapabilitiesFile(config: AppClawConfig, platform: Platform): Record<string, unknown> {
  const path = config.CAPABILITIES_FILE?.trim();
  if (!path) return {};

  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    throw new Error(`CAPABILITIES_FILE not found: ${path} (resolved to ${resolved})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (e: any) {
    throw new Error(`CAPABILITIES_FILE ${path} is not valid JSON: ${e?.message ?? e}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`CAPABILITIES_FILE ${path} must be a JSON object of capabilities`);
  }

  return normalizeCapabilitiesForPlatform(parsed, platform, `CAPABILITIES_FILE ${path}`);
}

/** Build Android-specific session capabilities (MJPEG, app install etc.) */
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
  if (config.APP_PATH) {
    caps['appium:app'] = config.APP_PATH;
  }

  return caps;
}

/** Create a remote Appium session on LambdaTest cloud. */
async function createLambdaTestSession(
  mcp: MCPClient,
  config: AppClawConfig,
  platform: Platform,
  fileCaps: Record<string, unknown> = {}
): Promise<SessionResult> {
  ui.startSpinner('Creating LambdaTest cloud session...');

  const hubUrl = `https://${config.LAMBDATEST_USERNAME}:${config.LAMBDATEST_ACCESS_KEY}@mobile-hub.lambdatest.com/wd/hub`;

  const ltOptions: Record<string, unknown> = {
    video: config.LAMBDATEST_VIDEO === 'true',
    network: config.LAMBDATEST_NETWORK === 'true',
    isRealMobile: true,
  };
  if (config.LAMBDATEST_BUILD_NAME) ltOptions.build = config.LAMBDATEST_BUILD_NAME;
  if (config.LAMBDATEST_PROJECT_NAME) ltOptions.project = config.LAMBDATEST_PROJECT_NAME;
  if (config.LAMBDATEST_APP) ltOptions.app = config.LAMBDATEST_APP;

  const capabilities: Record<string, unknown> = {
    'appium:deviceName': config.LAMBDATEST_DEVICE_NAME,
    'appium:platformVersion': config.LAMBDATEST_OS_VERSION,
    'lt:options': ltOptions,
    // User-supplied caps win over the cloud defaults above (their explicit choice).
    ...fileCaps,
  };

  const args: Record<string, unknown> = {
    platform,
    remoteServerUrl: hubUrl,
    capabilities: JSON.stringify(capabilities),
  };

  try {
    const sessionResult = await mcp.callTool('appium_session_management', {
      action: 'create',
      ...args,
    });
    const resultText = extractText(sessionResult);

    if (resultText.toLowerCase().includes('error') || resultText.toLowerCase().includes('failed')) {
      throw new Error(resultText);
    }

    ui.stopSpinner();
    ui.printSetupOk(
      `LambdaTest session created — ${config.LAMBDATEST_DEVICE_NAME} (iOS ${config.LAMBDATEST_OS_VERSION})`
    );

    const sessionIdMatch = resultText.match(/session created successfully with ID:\s*(\S+)/i);
    const sessionId = sessionIdMatch?.[1] ?? 'session';

    const scopedMcp = new SessionScopedMCPClient(mcp, sessionId);
    setDevicePlatform(scopedMcp, platform);
    await detectScreenSize(scopedMcp, platform);

    return { platform, sessionText: resultText, sessionId, scopedMcp };
  } catch (err: any) {
    ui.stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    ui.printSetupError(
      `Failed to create LambdaTest session: ${msg}`,
      'Check LAMBDATEST_USERNAME, LAMBDATEST_ACCESS_KEY, LAMBDATEST_DEVICE_NAME, and LAMBDATEST_OS_VERSION'
    );
    throw err;
  }
}

/** Detect device screen size after session creation */
async function detectScreenSize(mcp: MCPClient, platform: Platform): Promise<void> {
  if (platform === 'ios') {
    // iOS strategy 1: exact point dimensions from hardware model identifier.
    // This is the most reliable source — avoids any ambiguity between pixels and points.
    try {
      const result = await mcp.callTool('appium_mobile_device_info', {});
      const text = extractText(result);
      const modelId = extractIOSModelFromDeviceInfo(text);
      if (modelId) {
        const size = getIOSScreenSizeFromModel(modelId);
        if (size) {
          setDeviceScreenSize(mcp, `${size.width}x${size.height}`);
          return;
        }
      }
    } catch {
      /* tool not available */
    }

    // iOS strategy 2: appium_get_window_rect — returns logical points per W3C spec.
    // Only accept values that are plausibly in point space (max edge ≤ 1500).
    // Values above that are likely physical pixels from a non-compliant MCP setup;
    // skip them here and let getScreenSizeForStark correct them at runtime using
    // the actual screenshot for comparison.
    try {
      const result = await mcp.callTool('appium_get_window_size', {});
      const text = extractText(result);
      try {
        const obj = JSON.parse(text);
        const w = Number(obj.width ?? obj.w);
        const h = Number(obj.height ?? obj.h);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          if (Math.max(w, h) <= 1500) {
            // Safe to treat as logical points
            setDeviceScreenSize(mcp, `${Math.round(w)}x${Math.round(h)}`);
            return;
          }
          // Otherwise: likely pixels — skip; getScreenSizeForStark will correct at runtime
        }
      } catch {
        /* not JSON */
      }
    } catch {
      /* tool not available */
    }

    // iOS: don't fall through to appium_mobile_device_info for realDisplaySize —
    // that field is Android-only (physical pixels, wrong coordinate space for iOS taps).
    return;
  }

  // Android: get physical pixel dimensions from device info
  try {
    const result = await mcp.callTool('appium_mobile_device_info', {});
    const text = extractText(result);

    // Android: realDisplaySize (e.g. "720x1600")
    const sizeMatch = text.match(/realDisplaySize['":\s]+(\d+x\d+)/i);
    if (sizeMatch) {
      setDeviceScreenSize(mcp, sizeMatch[1]);
      return;
    }

    // Try JSON parse
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
  }
}
