/**
 * Device setup pipeline — orchestrates platform selection, device discovery,
 * iOS setup (simulator boot + WDA), and session creation.
 *
 * Single entry point for all modes (agent, flow, explorer, replay).
 */

export { resolvePlatform } from './platform-picker.js';
export { discoverAndSelectDevice } from './device-picker.js';
export type { DeviceInfo, DeviceSelection } from './device-picker.js';
export { setupSimulator, checkRealDeviceWDA } from './ios-setup.js';
export { createPlatformSession } from './session.js';
export type { SessionResult } from './session.js';

import type { MCPClient } from '../mcp/types.js';
import type { AppClawConfig } from '../config.js';
import type { Platform, DeviceType } from '../index.js';
import { resolvePlatform } from './platform-picker.js';
import { discoverAndSelectDevice } from './device-picker.js';
import { setupSimulator, checkRealDeviceWDA } from './ios-setup.js';
import { createPlatformSession } from './session.js';
import type { SessionResult } from './session.js';

export interface DeviceSetupArgs {
  cliPlatform: Platform | null;
  cliDeviceType: DeviceType | null;
  cliUdid: string | null;
  cliDeviceName: string | null;
  config: AppClawConfig;
  /**
   * Extra Appium capabilities merged into the session for this specific device.
   * Used by parallel runners to assign unique ports per worker:
   * - Android: `appium:systemPort`, `appium:mjpegServerPort`, `appium:mjpegScreenshotUrl`
   * - iOS: `appium:wdaLocalPort`
   */
  extraCaps?: Record<string, unknown>;
}

export interface DeviceSetupResult {
  platform: Platform;
  deviceType?: DeviceType;
  deviceName: string;
  deviceUdid: string;
  session: SessionResult;
  /** Appium session ID returned by create_session. */
  sessionId: string;
  /**
   * Session-scoped MCP wrapper. Use this for all post-setup tool calls
   * (flows, agent loop, app resolver) so every call targets the right device.
   * Especially important in parallel runs where multiple sessions share one process.
   */
  scopedMcp: MCPClient;
}

/**
 * Full device setup pipeline:
 * 1. Resolve platform (CLI / env / prompt)
 * 2. Connect to MCP & discover devices
 * 3. iOS: boot simulator + WDA setup, or real device check
 * 4. Create Appium session
 */
export async function setupDevice(
  mcp: MCPClient,
  args: DeviceSetupArgs
): Promise<DeviceSetupResult> {
  // Step 1: Resolve platform + device type
  const { platform, deviceType } = await resolvePlatform({
    cliPlatform: args.cliPlatform,
    cliDeviceType: args.cliDeviceType,
    config: args.config,
  });

  // Step 2: Discover and select a device
  // Use CLI args first, then fall back to config env vars
  const udid = args.cliUdid || args.config.DEVICE_UDID || null;
  const deviceName = args.cliDeviceName || args.config.DEVICE_NAME || null;

  // If platform was chosen interactively (not via CLI/env), always show the device picker
  // so the user can choose which device they want. Only auto-select when explicitly set.
  const explicitDevice = !!(udid || deviceName);
  const explicitPlatform = !!(args.cliPlatform || args.config.PLATFORM);
  const forceDevicePicker = !explicitDevice && !explicitPlatform;

  const selection = await discoverAndSelectDevice(
    mcp,
    platform,
    deviceType,
    udid,
    deviceName,
    forceDevicePicker
  );

  // Step 3: iOS-specific setup
  if (platform === 'ios' && deviceType === 'simulator') {
    await setupSimulator(mcp, selection.device.udid);
  } else if (platform === 'ios' && deviceType === 'real') {
    await checkRealDeviceWDA();
  }

  // Step 4: Create session
  const session = await createPlatformSession(
    mcp,
    args.config,
    platform,
    deviceType,
    args.extraCaps
  );

  return {
    platform,
    deviceType,
    deviceName: selection.device.name,
    deviceUdid: selection.device.udid,
    session,
    sessionId: session.sessionId,
    scopedMcp: session.scopedMcp,
  };
}
