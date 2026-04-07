/**
 * Platform & device type resolution.
 *
 * Priority: CLI flag → env var → interactive prompt (macOS + TTY) → default "android".
 */

import os from 'node:os';
import type { Platform, DeviceType } from '../index.js';
import type { AppClawConfig } from '../config.js';
import { interactivePicker } from './interactive-picker.js';
import * as ui from '../ui/terminal.js';

interface PlatformPickerArgs {
  cliPlatform: Platform | null;
  cliDeviceType: DeviceType | null;
  config: AppClawConfig;
}

interface PlatformResult {
  platform: Platform;
  deviceType: DeviceType | undefined;
}

/**
 * Resolve the target platform from CLI flags, env vars, or interactive prompt.
 */
export async function resolvePlatform(args: PlatformPickerArgs): Promise<PlatformResult> {
  let platform = resolvePlatformValue(args.cliPlatform, args.config);
  let deviceType = resolveDeviceTypeValue(args.cliDeviceType, args.config);

  // If no platform resolved and we can prompt, ask the user
  if (!platform) {
    if (canPrompt()) {
      platform = await promptPlatform();
    } else {
      // Non-interactive: default to android
      platform = 'android';
    }
  }

  // If iOS and no device type resolved, prompt for it
  if (platform === 'ios' && !deviceType) {
    if (canPrompt()) {
      deviceType = await promptDeviceType();
    } else {
      // Non-interactive iOS without device type: error
      ui.printError(
        'iOS requires --device-type (simulator or real)',
        'Set --device-type simulator or --device-type real, or DEVICE_TYPE env var.'
      );
      process.exit(1);
    }
  }

  return { platform, deviceType: platform === 'ios' ? (deviceType ?? undefined) : undefined };
}

/** Resolve platform from CLI flag or env var. Returns null if unset. */
function resolvePlatformValue(
  cliFlagValue: Platform | null,
  config: AppClawConfig
): Platform | null {
  if (cliFlagValue) return cliFlagValue;
  const envVal = config.PLATFORM;
  if (envVal === 'android' || envVal === 'ios') return envVal;
  return null;
}

/** Resolve device type from CLI flag or env var. Returns null if unset. */
function resolveDeviceTypeValue(
  cliFlagValue: DeviceType | null,
  config: AppClawConfig
): DeviceType | null {
  if (cliFlagValue) return cliFlagValue;
  const envVal = config.DEVICE_TYPE;
  if (envVal === 'simulator' || envVal === 'real') return envVal;
  return null;
}

/** Check if we can show interactive prompts (TTY). */
function canPrompt(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Check if running on macOS (only macOS can run iOS simulators). */
export function isMacOS(): boolean {
  return os.platform() === 'darwin';
}

/** Interactive platform prompt */
async function promptPlatform(): Promise<Platform> {
  const items: { label: string; value: Platform }[] = [{ label: 'Android', value: 'android' }];

  // Only show iOS option on macOS
  if (isMacOS()) {
    items.push({ label: 'iOS', value: 'ios' });
  }

  // If only Android available, skip prompt
  if (items.length === 1) return 'android';

  return interactivePicker(items, {
    prompt: 'Select platform:',
    searchable: false,
  });
}

/**
 * Inline platform prompt for the interactive goal screen.
 * Returns the selected platform, or null if only one option (auto-selects android).
 */
export async function promptPlatformInline(): Promise<Platform | null> {
  if (!canPrompt()) return null;

  const items: { label: string; value: Platform }[] = [{ label: 'Android', value: 'android' }];

  if (isMacOS()) {
    items.push({ label: 'iOS', value: 'ios' });
  }

  // Only one option — no need to prompt
  if (items.length === 1) return null;

  return interactivePicker(items, {
    prompt: 'Select platform:',
    searchable: false,
  });
}

/** Interactive device type prompt (simulator vs real) */
async function promptDeviceType(): Promise<DeviceType> {
  return interactivePicker(
    [
      { label: 'Simulator', value: 'simulator' as DeviceType },
      { label: 'Real Device', value: 'real' as DeviceType },
    ],
    {
      prompt: 'Select device type:',
      searchable: false,
    }
  );
}
