import { Config, type AppClawConfig } from '../config.js';

/**
 * API key used by StarkVisionClient.
 * Priority: STARK_VISION_API_KEY → GEMINI_API_KEY → LLM_API_KEY (when provider is gemini)
 */
export function getStarkVisionApiKey(): string {
  const explicit = (Config.STARK_VISION_API_KEY || Config.GEMINI_API_KEY).trim();
  if (explicit) return explicit;
  if (Config.LLM_PROVIDER === 'gemini' && Config.LLM_API_KEY.trim()) {
    return Config.LLM_API_KEY.trim();
  }
  return '';
}

/**
 * Gemini model id for Stark.
 * Uses LLM_MODEL when provider is gemini, otherwise falls back to the default.
 */
export function getStarkVisionModel(): string {
  if (Config.LLM_PROVIDER === 'gemini' && Config.LLM_MODEL.trim()) {
    return Config.LLM_MODEL.trim();
  }
  return 'gemini-3.1-flash-lite-preview';
}

function starkConfigured(c: AppClawConfig): boolean {
  if ((c.STARK_VISION_API_KEY || c.GEMINI_API_KEY).trim().length > 0) return true;
  if (c.LLM_PROVIDER === 'gemini' && c.LLM_API_KEY.trim().length > 0) return true;
  return false;
}

/** Whether NL visual locate is available (Stark vision). */
export function isVisionLocateEnabledFromConfig(c: AppClawConfig): boolean {
  return starkConfigured(c);
}

/** Uses process-wide `Config` (same as CLI). */
export function isVisionLocateEnabled(): boolean {
  return isVisionLocateEnabledFromConfig(Config);
}
