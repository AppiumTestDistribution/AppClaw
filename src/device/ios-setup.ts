/**
 * iOS simulator setup orchestration.
 *
 * Automates: boot simulator → download WDA → install WDA.
 * All via appium-mcp tools — no direct xcrun/simctl calls.
 *
 * For real devices, provides guidance on WDA signing requirements.
 */

import type { MCPClient } from '../mcp/types.js';
import { extractText } from '../mcp/tools.js';
import * as ui from '../ui/terminal.js';

/**
 * Full simulator setup: boot + WDA download + WDA install.
 * Uses the prepare_ios_simulator tool which handles all three steps in one call.
 */
export async function setupSimulator(mcp: MCPClient, udid: string): Promise<void> {
  ui.startSpinner('Preparing iOS simulator...');
  let result: any;
  try {
    const mcpResult = await mcp.callTool('prepare_ios_simulator', { udid });
    const text = extractText(mcpResult);
    try {
      result = JSON.parse(text);
    } catch {
      result = null;
    }
  } catch (err: any) {
    ui.stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    ui.printSetupError(`Failed to prepare simulator: ${msg}`, 'Run: xcrun simctl boot <udid>');
    throw err;
  }
  ui.stopSpinner();

  if (!result) {
    ui.printSetupOk('iOS simulator prepared');
    return;
  }

  // Boot step
  if (result.boot?.status === 'failed') {
    ui.printSetupError(
      `Failed to boot simulator: ${result.boot.detail}`,
      'Run: xcrun simctl boot <udid>'
    );
    throw new Error(result.boot.detail);
  } else if (result.boot?.status === 'skipped') {
    ui.printSetupOk(`Simulator already booted`);
  } else if (result.boot?.status === 'completed') {
    ui.printSetupOk('Simulator booted');
  }

  // WDA download step
  if (result.wda_download?.status === 'failed') {
    ui.printSetupError(
      `Failed to download WDA: ${result.wda_download.detail}`,
      'Check network connection. WDA is downloaded from GitHub releases.'
    );
    throw new Error(result.wda_download.detail);
  } else if (result.wda_download?.status === 'completed') {
    ui.printSetupOk('WebDriverAgent downloaded');
  } else if (result.wda_download?.status === 'skipped') {
    ui.printSetupOk('WebDriverAgent ready (cached)');
  }

  // WDA install step
  if (result.wda_install?.status === 'failed') {
    ui.printSetupError(
      `Failed to install WDA: ${result.wda_install.detail}`,
      'Try resetting the simulator: xcrun simctl erase <udid>'
    );
    throw new Error(result.wda_install.detail);
  } else if (result.wda_install?.status === 'completed') {
    ui.printSetupOk('WebDriverAgent installed on simulator');
  } else if (result.wda_install?.status === 'skipped') {
    ui.printSetupOk('WebDriverAgent already installed');
  }
}

/**
 * Check WDA readiness for real devices.
 * Real devices require WDA signed via Xcode — we can't automate this.
 * Show guidance and let the user decide whether to proceed.
 */
export async function checkRealDeviceWDA(): Promise<void> {
  ui.printWarning(
    'Real iOS devices require WebDriverAgent installed via Xcode.\n' +
      '    See: https://appium.github.io/appium-xcuitest-driver/latest/preparation/real-device-config/'
  );

  // In non-interactive mode (CI), assume WDA is pre-installed
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    ui.printInfo('Non-interactive mode — assuming WDA is pre-installed on device.');
    return;
  }

  // Ask user to confirm
  return new Promise((resolve) => {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question('  Continue (WDA already installed)? [Y/n] ', (answer: string) => {
      rl.close();
      const val = answer.trim().toLowerCase();
      if (val === 'n' || val === 'no') {
        ui.printInfo('Setup cancelled. Install WDA via Xcode first.');
        process.exit(0);
      }
      resolve();
    });
  });
}
