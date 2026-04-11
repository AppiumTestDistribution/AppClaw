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
 * Uses STARK_VISION_MODEL if set, then LLM_MODEL when provider is gemini, else a built-in default.
 */
export function getStarkVisionModel(): string {
  if (Config.STARK_VISION_MODEL.trim()) return Config.STARK_VISION_MODEL.trim();
  if (Config.LLM_PROVIDER === 'gemini' && Config.LLM_MODEL.trim()) {
    return Config.LLM_MODEL.trim();
  }
  return 'gemini-3.1-flash-lite-preview';
}

/**
 * Base URL for an OpenAI-compatible local vision server.
 * When set, stark-vision routes calls through the local server instead of Google GenAI.
 */
export function getStarkVisionBaseUrl(): string | undefined {
  return Config.STARK_VISION_BASE_URL.trim() || undefined;
}

/**
 * Coordinate order for the local vision model.
 * 'yx' = model returns [y, x] (default, correct per prompt).
 * 'xy' = model returns [x, y] despite prompt (swap needed).
 */
export function getStarkVisionCoordinateOrder(): 'yx' | 'xy' {
  return Config.STARK_VISION_COORDINATE_ORDER;
}

function starkConfigured(c: AppClawConfig): boolean {
  // Local server mode — no cloud API key needed
  if (c.STARK_VISION_BASE_URL.trim()) return true;
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
