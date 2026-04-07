/**
 * W3C-style keyboard input via ADB.
 *
 * Sends key events directly to the focused element — no element UUID needed.
 * This replaces appium_set_value which requires a valid (non-stale) element
 * reference and often fails on Compose/custom UIs.
 *
 * Uses ADB `input text` for Android, which dispatches key events through the
 * input method to whatever element currently has focus — functionally identical
 * to W3C Actions keyboard input.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface KeyboardResult {
  success: boolean;
  message: string;
}

/**
 * Type text into the currently focused element via ADB keyboard input.
 *
 * @param text - The text to type
 * @param deviceUdid - Optional device UDID (required if multiple devices connected)
 */
export async function typeViaKeyboard(text: string, deviceUdid?: string): Promise<KeyboardResult> {
  const adbPath = getADBPath();

  // ADB `input text` requires escaping: spaces → %s, special chars need shell escaping
  const escaped = escapeForADBInput(text);

  const deviceFlag = deviceUdid ? `-s ${deviceUdid}` : '';

  try {
    await execAsync(`${adbPath} ${deviceFlag} shell input text "${escaped}"`, {
      timeout: 10000,
    });
    return { success: true, message: `Typed "${text}" via keyboard input` };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Keyboard input failed: ${errMsg}` };
  }
}

/**
 * Detect the connected device UDID via ADB.
 * Returns null if no device or multiple devices found.
 */
export async function detectDeviceUdid(): Promise<string | null> {
  const adbPath = getADBPath();
  try {
    const { stdout } = await execAsync(`${adbPath} devices`, { timeout: 5000 });
    const lines = stdout
      .split('\n')
      .filter((l) => l.includes('\tdevice'))
      .map((l) => l.split('\t')[0].trim());
    return lines.length === 1 ? lines[0] : null;
  } catch {
    return null;
  }
}

/** Escape text for ADB `input text` command */
function escapeForADBInput(text: string): string {
  // ADB input text encoding:
  // - Spaces must be encoded as %s
  // - Shell metacharacters need escaping
  return text
    .replace(/%/g, '%%')
    .replace(/ /g, '%s')
    .replace(/['"\\&|<>(){}$`!#~;]/g, '\\$&');
}

/**
 * Press the Enter/Return key via ADB (Android keycode 66).
 * Used to submit search queries, confirm text input, or dismiss the keyboard.
 */
export async function pressEnterKey(deviceUdid?: string): Promise<KeyboardResult> {
  const adbPath = getADBPath();
  const deviceFlag = deviceUdid ? `-s ${deviceUdid}` : '';

  try {
    await execAsync(`${adbPath} ${deviceFlag} shell input keyevent 66`, {
      timeout: 5000,
    });
    return { success: true, message: 'Pressed Enter key' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Press Enter failed: ${errMsg}` };
  }
}

function getADBPath(): string {
  const androidHome =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    `${process.env.HOME}/Library/Android/sdk`;
  return `${androidHome}/platform-tools/adb`;
}
