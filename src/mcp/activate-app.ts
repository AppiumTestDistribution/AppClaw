/**
 * appium_activate_app can fail on some OEM builds when `cmd package resolve-activity`
 * returns no launchable activity (e.g. Samsung + YouTube). Try deep-link fallbacks.
 */

import type { MCPClient } from './types.js';
import { extractText } from './tools.js';

/** Package → https URL that reliably opens the app when activate_app fails */
const DEEP_LINK_BY_PACKAGE: Record<string, string> = {
  'com.google.android.youtube': 'https://www.youtube.com/',
};

function responseLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('error') ||
    t.includes('failed') ||
    t.includes('unable to resolve') ||
    t.includes('launchable activity') ||
    t.includes('nosuchdriver') ||
    t.includes('not found')
  );
}

async function callToolQuiet(
  mcp: MCPClient,
  name: string,
  args: Record<string, unknown>
): Promise<string | null> {
  try {
    const r = await mcp.callTool(name, args);
    return extractText(r);
  } catch {
    return null;
  }
}

/**
 * Activate by package id; on resolve-activity failures try appium_deep_link / mobile: deepLink.
 */
export async function activateAppWithFallback(
  mcp: MCPClient,
  packageId: string
): Promise<{ success: boolean; message: string }> {
  const primary = await mcp.callTool('appium_activate_app', { id: packageId });
  const t0 = extractText(primary);
  if (!responseLooksLikeFailure(t0)) {
    return { success: true, message: t0.slice(0, 240) || `Activated ${packageId}` };
  }

  const url = DEEP_LINK_BY_PACKAGE[packageId];
  if (url) {
    const deepVariants: Record<string, unknown>[] = [
      { url, appId: packageId },
      { url, package: packageId },
    ];
    for (const deepArgs of deepVariants) {
      const t1 = await callToolQuiet(mcp, 'appium_deep_link', deepArgs);
      if (t1 !== null && !responseLooksLikeFailure(t1)) {
        return {
          success: true,
          message: `Deep link opened ${packageId}: ${t1.slice(0, 160)}`,
        };
      }
    }

    const t2 = await callToolQuiet(mcp, 'appium_execute_script', {
      script: 'mobile: deepLink',
      args: [{ url, package: packageId }],
    });
    if (t2 !== null && !responseLooksLikeFailure(t2)) {
      return { success: true, message: `mobile:deepLink: ${t2.slice(0, 200)}` };
    }

    const t3 = await callToolQuiet(mcp, 'appium_execute_script', {
      script: 'mobile: deepLink',
      args: [{ url, appPackage: packageId }],
    });
    if (t3 !== null && !responseLooksLikeFailure(t3)) {
      return { success: true, message: `mobile:deepLink: ${t3.slice(0, 200)}` };
    }
  }

  return {
    success: false,
    message: t0.slice(0, 400) || `Failed to activate ${packageId}`,
  };
}
