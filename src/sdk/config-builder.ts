/**
 * Config builder — maps AppClawOptions to AppClawConfig.
 *
 * Single Responsibility: translates the SDK's public option surface
 * into the internal env-var-keyed config object without touching process.env.
 */

import { loadConfig, type AppClawConfig } from '../config.js';
import type { AppClawOptions } from './types.js';

/** Mapping from AppClawOptions keys to their env-var equivalents. */
const OPTION_TO_ENV_VAR: Partial<Record<keyof AppClawOptions, string>> = {
  provider: 'LLM_PROVIDER',
  apiKey: 'LLM_API_KEY',
  model: 'LLM_MODEL',
  platform: 'PLATFORM',
  agentMode: 'AGENT_MODE',
  maxSteps: 'MAX_STEPS',
  stepDelay: 'STEP_DELAY',
  mcpTransport: 'MCP_TRANSPORT',
  mcpHost: 'MCP_HOST',
  mcpPort: 'MCP_PORT',
  // `silent` is SDK-only — no env-var equivalent.
};

/**
 * Build an AppClawConfig from the SDK options object.
 *
 * Explicitly-set options take priority over env vars.
 * Unset options fall through to process.env (same as CLI behaviour).
 */
export function buildConfig(options: AppClawOptions): AppClawConfig {
  const overrides: Record<string, string> = {};

  for (const [key, envVar] of Object.entries(OPTION_TO_ENV_VAR)) {
    if (!envVar) continue;
    const val = options[key as keyof AppClawOptions];
    if (val !== undefined) {
      overrides[envVar] = String(val);
    }
  }

  return loadConfig(overrides);
}
