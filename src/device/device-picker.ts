/**
 * Device discovery and selection via appium-mcp tools.
 *
 * Calls select_platform to list available devices, then select_device
 * to lock in the choice. Supports interactive picking or explicit UDID/name.
 *
 * Features:
 * - Booted devices sorted to top
 * - Filters out "Unknown", Apple TV, and duplicate devices
 * - Searchable interactive picker for long lists
 */

import type { MCPClient } from '../mcp/types.js';
import type { Platform, DeviceType } from '../index.js';
import { extractText } from '../mcp/tools.js';
import { interactivePicker } from './interactive-picker.js';
import type { PickerItem } from './interactive-picker.js';
import * as ui from '../ui/terminal.js';

export interface DeviceInfo {
  name: string;
  udid: string;
  state?: string; // "Booted", "Shutdown", etc.
  platform?: string; // iOS version for simulators
}

export interface DeviceSelection {
  device: DeviceInfo;
  platform: Platform;
  deviceType?: DeviceType;
}

/**
 * Discover available devices by calling select_platform, then pick one.
 *
 * If udid or deviceName is provided, auto-selects that device.
 * Otherwise shows an interactive picker (if TTY) or picks the first available.
 */
export async function discoverAndSelectDevice(
  mcp: MCPClient,
  platform: Platform,
  deviceType: DeviceType | undefined,
  udid: string | null,
  deviceName: string | null,
  forceDevicePicker: boolean = false
): Promise<DeviceSelection> {
  // Fast path: UDID already known — skip device enumeration entirely.
  // select_device accepts deviceUdid directly and will bypass the slow list call.
  if (udid && !forceDevicePicker) {
    ui.startSpinner(`Selecting ${platform} device...`);
    await selectDeviceOnMcp(mcp, platform, deviceType, udid);
    ui.stopSpinner();
    ui.printSetupOk(`Selected device ${udid}`);
    return { device: { name: udid, udid }, platform, deviceType };
  }

  // Step 1: Call select_device to discover available devices
  ui.startSpinner(`Discovering ${platform} devices...`);

  const selectPlatformArgs: Record<string, unknown> = { platform };
  if (platform === 'ios' && deviceType) {
    selectPlatformArgs.iosDeviceType = deviceType;
  }

  const platformResult = await mcp.callTool('select_device', selectPlatformArgs);
  const platformText = extractText(platformResult);
  ui.stopSpinner();

  // Check for errors
  if (
    platformText.toLowerCase().includes('no devices') ||
    platformText.toLowerCase().includes('no simulators') ||
    platformText.toLowerCase().includes('no ios devices')
  ) {
    const hint =
      platform === 'android'
        ? 'Connect a device/emulator: adb devices'
        : deviceType === 'simulator'
          ? 'Open Simulator.app or run: xcrun simctl list devices'
          : 'Connect an iOS device via USB and trust this computer';
    ui.printSetupError(`No ${platform} ${deviceType ?? ''} devices found.`, hint);
    process.exit(1);
  }

  // Step 2: Parse device list from response
  let devices = parseDeviceList(platformText, platform);

  // Clean up the list: remove junk, deduplicate, sort
  devices = cleanAndSortDevices(devices);

  if (devices.length === 0) {
    // If we couldn't parse but select_platform didn't error,
    // there may be exactly one device — proceed with select_device directly
    ui.printSetupOk(`${platform} device available`);
    await selectDeviceOnMcp(mcp, platform, deviceType, udid ?? undefined);
    return {
      device: { name: 'Unknown Device', udid: udid ?? 'auto' },
      platform,
      deviceType,
    };
  }

  // Step 3: Pick a device
  let selectedDevice: DeviceInfo;

  if (udid) {
    // Explicit UDID — find matching device
    const match = devices.find((d) => d.udid === udid);
    if (!match) {
      ui.printError(
        `Device with UDID "${udid}" not found.`,
        `Available:\n${devices.map((d) => `  ${d.name} (${d.udid})`).join('\n')}`
      );
      process.exit(1);
    }
    selectedDevice = match;
  } else if (deviceName) {
    // Explicit name — find matching device (case-insensitive partial match)
    const match = devices.find((d) => d.name.toLowerCase().includes(deviceName.toLowerCase()));
    if (!match) {
      ui.printError(
        `Device "${deviceName}" not found.`,
        `Available:\n${devices.map((d) => `  ${d.name} (${d.udid})`).join('\n')}`
      );
      process.exit(1);
    }
    selectedDevice = match;
  } else if (devices.length === 1 && !forceDevicePicker) {
    // Only one device + explicit CLI selection — auto-select
    selectedDevice = devices[0];
    ui.printSetupOk(
      `Selected ${selectedDevice.name}${selectedDevice.state ? ` (${selectedDevice.state})` : ''}`
    );
  } else if (!forceDevicePicker) {
    // Multiple devices with explicit CLI — auto-select if exactly one is booted
    const bootedDevices = devices.filter((d) => d.state?.toLowerCase() === 'booted');
    if (bootedDevices.length === 1) {
      selectedDevice = bootedDevices[0];
      ui.printSetupOk(`Auto-selected ${selectedDevice.name} (Booted)`);
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      selectedDevice = await promptDevicePicker(devices);
    } else {
      // Non-interactive: prefer booted device, else first
      selectedDevice = bootedDevices[0] ?? devices[0];
      ui.printInfo(`Auto-selected ${selectedDevice.name} (use --udid to specify)`);
    }
  } else {
    // Interactive mode — always show picker so user can choose
    if (process.stdin.isTTY && process.stdout.isTTY) {
      selectedDevice = await promptDevicePicker(devices);
    } else {
      const bootedDevices = devices.filter((d) => d.state?.toLowerCase() === 'booted');
      selectedDevice = bootedDevices[0] ?? devices[0];
      ui.printInfo(`Auto-selected ${selectedDevice.name} (use --udid to specify)`);
    }
  }

  // Step 4: Call select_device to lock in the choice
  await selectDeviceOnMcp(mcp, platform, deviceType, selectedDevice.udid);

  return { device: selectedDevice, platform, deviceType };
}

/** Call the select_device MCP tool to store the selection globally in appium-mcp */
async function selectDeviceOnMcp(
  mcp: MCPClient,
  platform: Platform,
  deviceType: DeviceType | undefined,
  deviceUdid?: string
): Promise<void> {
  const args: Record<string, unknown> = { platform };
  if (platform === 'ios' && deviceType) {
    args.iosDeviceType = deviceType;
  }
  if (deviceUdid) {
    args.deviceUdid = deviceUdid;
  }
  await mcp.callTool('select_device', args);
}

/**
 * Clean up, deduplicate, and sort device list:
 * - Filter out "Unknown" named devices and non-phone/tablet devices (Apple TV)
 * - Deduplicate by UDID (keep first occurrence)
 * - Sort: Booted first, then by name alphabetically
 */
function cleanAndSortDevices(devices: DeviceInfo[]): DeviceInfo[] {
  // Filter out junk
  const filtered = devices.filter((d) => {
    const name = d.name.toLowerCase();
    // Remove devices named "Unknown" or empty
    if (name === 'unknown' || !name || name === 'my device name') return false;
    // Remove Apple TV devices (not useful for mobile testing)
    if (name.includes('apple tv')) return false;
    return true;
  });

  // Deduplicate by UDID
  const seen = new Set<string>();
  const unique = filtered.filter((d) => {
    if (seen.has(d.udid)) return false;
    seen.add(d.udid);
    return true;
  });

  // Sort: booted first, then by name
  unique.sort((a, b) => {
    const aBooted = a.state?.toLowerCase() === 'booted' ? 0 : 1;
    const bBooted = b.state?.toLowerCase() === 'booted' ? 0 : 1;
    if (aBooted !== bBooted) return aBooted - bBooted;
    return a.name.localeCompare(b.name);
  });

  return unique;
}

/**
 * Parse device list from select_platform response text.
 * The response format varies but typically includes device names and UDIDs.
 */
export function parseDeviceList(text: string, _platform: Platform): DeviceInfo[] {
  const devices: DeviceInfo[] = [];

  // Try JSON parse first (appium-mcp sometimes returns JSON)
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      for (const d of data) {
        if (d.udid || d.UDID) {
          devices.push({
            name: d.name || d.deviceName || d.model || 'Unknown',
            udid: d.udid || d.UDID,
            state: d.state,
            platform: d.platform || d.version,
          });
        }
      }
      if (devices.length > 0) return devices;
    }
  } catch {
    // Not JSON, parse as text
  }

  // Parse text format — look for patterns like:
  // "1. iPhone 16 Pro (E9F10A3E-58E6-4506-B273-B22AF836014E) - Shutdown"
  // "- iPhone 15 (iOS 17.5) | UDID: XXXXXXXX | State: Shutdown"
  const lines = text.split('\n');

  for (const line of lines) {
    // Match UDID patterns — ordered from most specific to least specific:
    // 1. Android emulator: "emulator-5554"
    // 2. Explicit UDID= label
    // 3. Standard UUID in parens (iOS simulators)
    // 4. Bare UUID (iOS simulators)
    // 5. Real device UDID (40 hex chars)
    // 6. Short iOS device UDID
    const udidMatch =
      line.match(/(emulator-\d+)/) || // Android emulator
      line.match(/(?:udid|UDID)[:\s=]+([A-F0-9-]{20,})/i) ||
      line.match(/\(([A-F0-9]{8}-(?:[A-F0-9]{4}-){3}[A-F0-9]{12})\)/i) ||
      line.match(/([A-F0-9]{8}-(?:[A-F0-9]{4}-){3}[A-F0-9]{12})/i) ||
      line.match(/([0-9A-F]{40})/i) || // Real device UDIDs (40 hex chars)
      line.match(/([0-9A-F]{8}-[0-9A-F]{16})/i) || // Short iOS device UDIDs
      line.match(/^\s*\d+\.\s+([A-Za-z0-9][A-Za-z0-9._:-]+)\s*$/); // appium-mcp numbered list: "  1. R9ZX6059BHW"

    if (!udidMatch) continue;

    const udid = udidMatch[1];

    // Use UDID as default name so real devices (non-emulator) are not filtered out
    let name = udid;

    if (!udid.startsWith('emulator-')) {
      const nameMatch =
        line.match(/(?:^[-\d.\s]*)([\w][\w\s']+?)(?:\s*\(|\s*[-|]?\s*(?:udid|UDID|state))/i) ||
        line.match(/(?:name|device)[:\s=]+([^\n|,]+)/i);
      if (nameMatch) {
        name = nameMatch[1].trim();
      }
    }

    // Extract state
    let state: string | undefined;
    const stateMatch =
      line.match(/(?:state|status)[:\s=]+(\w+)/i) ||
      line.match(/[-–]\s*(Booted|Shutdown|Shutting Down)/i);
    if (stateMatch) {
      state = stateMatch[1];
    }

    // Extract platform/version
    let platformVersion: string | undefined;
    const versionMatch = line.match(/(?:iOS|platform)\s+([\d.]+)/i);
    if (versionMatch) {
      platformVersion = versionMatch[1];
    }

    devices.push({ name, udid, state, platform: platformVersion });
  }

  return devices;
}

/** Interactive device picker using the shared searchable picker */
async function promptDevicePicker(devices: DeviceInfo[]): Promise<DeviceInfo> {
  const items: PickerItem<DeviceInfo>[] = devices.map((d) => {
    const tag = d.state?.toLowerCase() === 'booted' ? 'Booted' : undefined;
    const hint =
      d.state?.toLowerCase() !== 'booted' && d.platform
        ? `iOS ${d.platform}`
        : d.platform
          ? `iOS ${d.platform}`
          : undefined;

    return {
      label: d.name,
      value: d,
      tag,
      hint,
    };
  });

  // Start selection on first booted device (if any)
  return interactivePicker(items, {
    prompt: 'Select device:',
    viewportSize: 12,
    searchable: devices.length > 5,
  });
}
