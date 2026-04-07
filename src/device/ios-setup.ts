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
 * Each step is idempotent (skips if already done).
 */
export async function setupSimulator(mcp: MCPClient, udid: string): Promise<void> {
  // Step 1: Boot simulator
  ui.startSpinner('Booting simulator...');
  try {
    const bootResult = await mcp.callTool('boot_simulator', { udid });
    const bootText = extractText(bootResult);

    if (bootText.toLowerCase().includes('error') || bootText.toLowerCase().includes('failed')) {
      throw new Error(bootText);
    }

    ui.stopSpinner();
    if (
      bootText.toLowerCase().includes('already booted') ||
      bootText.toLowerCase().includes('already running')
    ) {
      ui.printSetupOk('Simulator already booted');
    } else {
      ui.printSetupOk('Simulator booted');
    }
  } catch (err: any) {
    ui.stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    // "Already booted" is not an error
    if (
      msg.toLowerCase().includes('already booted') ||
      msg.toLowerCase().includes('already running')
    ) {
      ui.printSetupOk('Simulator already booted');
    } else {
      ui.printSetupError(
        `Failed to boot simulator: ${msg}`,
        'Try closing other simulators or run: xcrun simctl boot <udid>'
      );
      throw err;
    }
  }

  // Step 2: Download/setup WDA (cached in ~/.cache/appium-mcp/wda/)
  ui.startSpinner('Setting up WebDriverAgent...');
  try {
    const wdaResult = await mcp.callTool('setup_wda', { platform: 'ios' });
    const wdaText = extractText(wdaResult);

    if (wdaText.toLowerCase().includes('error') || wdaText.toLowerCase().includes('failed')) {
      throw new Error(wdaText);
    }

    ui.stopSpinner();
    if (wdaText.toLowerCase().includes('cached') || wdaText.toLowerCase().includes('already')) {
      ui.printSetupOk('WebDriverAgent ready (cached)');
    } else {
      ui.printSetupOk('WebDriverAgent downloaded');
    }
  } catch (err: any) {
    ui.stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    ui.printSetupError(
      `Failed to setup WebDriverAgent: ${msg}`,
      'Check network connection. WDA is downloaded from GitHub releases.'
    );
    throw err;
  }

  // Step 3: Install WDA on the booted simulator
  ui.startSpinner('Installing WebDriverAgent on simulator...');
  try {
    const installResult = await mcp.callTool('install_wda', { simulatorUdid: udid });
    const installText = extractText(installResult);

    if (
      installText.toLowerCase().includes('error') ||
      installText.toLowerCase().includes('failed')
    ) {
      throw new Error(installText);
    }

    ui.stopSpinner();
    if (
      installText.toLowerCase().includes('already installed') ||
      installText.toLowerCase().includes('already running')
    ) {
      ui.printSetupOk('WebDriverAgent already installed');
    } else {
      ui.printSetupOk('WebDriverAgent installed on simulator');
    }
  } catch (err: any) {
    ui.stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    // "Already installed" is acceptable
    if (
      msg.toLowerCase().includes('already installed') ||
      msg.toLowerCase().includes('already running')
    ) {
      ui.printSetupOk('WebDriverAgent already installed');
    } else {
      ui.printSetupError(
        `Failed to install WebDriverAgent: ${msg}`,
        'Try resetting the simulator: xcrun simctl erase <udid>'
      );
      throw err;
    }
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
