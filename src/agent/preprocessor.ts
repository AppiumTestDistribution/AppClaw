/**
 * Deterministic goal pre-processor — handles obvious actions without LLM calls.
 *
 * Deterministic pattern matching for common open/launch intents.
 * Pattern-matches goals like "open Settings", "launch WhatsApp", etc.
 * and executes them directly via MCP tools.
 */

import type { MCPClient } from '../mcp/types.js';
import { activateAppWithFallback } from '../mcp/activate-app.js';
import type { AppResolver } from './app-resolver.js';
import * as ui from '../ui/terminal.js';

export interface PreprocessResult {
  handled: boolean;
  action?: string;
  message?: string;
}

/**
 * Try to handle the goal (or sub-step) deterministically.
 * Returns { handled: true } if the action was executed directly.
 * Returns { handled: false } if the LLM should handle it.
 */
export async function preprocessAction(
  goal: string,
  mcp: MCPClient,
  appResolver: AppResolver
): Promise<PreprocessResult> {
  const trimmed = goal.trim();

  // ─── Pattern: compound goals with "open X and ..." ───────
  // Check BEFORE simple open — "open settings and toggle wifi" should
  // extract "settings" not "settings and toggle wifi"
  const compoundMatch = trimmed.match(
    /^(?:open|launch|start)\s+(?:the\s+)?(.+?)\s+(?:(?:app|application)\s+)?(?:and|then)\s+/i
  );
  if (compoundMatch) {
    // Strip trailing "app"/"application" from capture if regex didn't consume it
    const appName = compoundMatch[1].replace(/\s+(?:app|application)$/i, '').trim();
    const packageId = appResolver.resolve(appName);
    if (packageId) {
      ui.printStepDetail(`activateApp("${packageId}") for "${appName}"`);
      const r = await activateAppWithFallback(mcp, packageId);
      if (r.success) {
        return { handled: true, action: 'launch', message: `Launched ${appName} (${packageId})` };
      }
      return { handled: false };
    }
  }

  // ─── Pattern: "open X" / "launch X" / "start X" (simple, no "and") ───
  const openMatch = trimmed.match(
    /^(?:open|launch|start|go\s+to)\s+(?:the\s+)?(.+?)(?:\s+(?:app|application))?$/i
  );
  if (openMatch) {
    const appName = openMatch[1].trim();

    // Check if it's a URL
    if (/^https?:\/\//i.test(appName)) {
      const browserPkg = appResolver.resolve('chrome') ?? 'com.android.chrome';
      await mcp.callTool('appium_activate_app', { id: browserPkg });
      return { handled: true, action: 'open_url', message: `Opened browser for ${appName}` };
    }

    // Resolve app name to package ID
    const packageId = appResolver.resolve(appName);
    if (packageId) {
      ui.printStepDetail(`activateApp("${packageId}") for "${appName}"`);
      const r = await activateAppWithFallback(mcp, packageId);
      if (r.success) {
        return { handled: true, action: 'launch', message: `Launched ${appName} (${packageId})` };
      }
      return { handled: false };
    }
  }

  return { handled: false };
}

/**
 * Check if the LLM's "launch" action can be resolved and executed directly.
 * Called from the action executor when the LLM returns action: "launch".
 */
export function resolveAppId(appId: string | undefined, appResolver: AppResolver): string | null {
  if (!appId) return null;

  // Already a valid package name
  if (appId.includes('.') && appId.split('.').length >= 2) {
    return appId;
  }

  // Try resolving as app name
  return appResolver.resolve(appId);
}
