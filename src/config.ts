import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'gemini', 'groq', 'ollama']).default('gemini'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default(''),

  /** Ollama HTTP API base (default http://127.0.0.1:11434). Set for remote or Docker. */
  OLLAMA_BASE_URL: z.string().default(''),
  /** Bearer token for Ollama Cloud / authenticated endpoints (optional). */
  OLLAMA_API_KEY: z.string().default(''),

  /** Target platform: "android" or "ios". Empty = prompt on macOS, default android elsewhere. */
  PLATFORM: z.enum(['android', 'ios', '']).default(''),

  /** iOS device type: "simulator" or "real". Only used when PLATFORM=ios. */
  DEVICE_TYPE: z.enum(['simulator', 'real', '']).default(''),

  /** Device UDID to target. Skips interactive device picker when set. */
  DEVICE_UDID: z.string().default(''),

  /** Device name to target (e.g. "iPhone 16 Pro"). Alternative to DEVICE_UDID. */
  DEVICE_NAME: z.string().default(''),

  MCP_TRANSPORT: z.enum(['stdio', 'sse']).default('stdio'),
  MCP_HOST: z.string().default('localhost'),
  MCP_PORT: z.coerce.number().default(8080),

  /**
   * Android UiAutomator2: appium:mjpegScreenshotUrl — MJPEG stream URL for faster screenshots.
   * Default: http://127.0.0.1:7810 (matches default mjpegServerPort).
   */
  APPIUM_MJPEG_SCREENSHOT_URL: z.string().default('http://127.0.0.1:7810'),

  /**
   * Android UiAutomator2: appium:mjpegServerPort — port for the MJPEG screenshot server.
   * Default: 7810. Set to 0 to disable MJPEG and use normal screenshots.
   */
  APPIUM_MJPEG_SERVER_PORT: z.coerce.number().default(7810),

  MAX_STEPS: z.coerce.number().default(30),
  STEP_DELAY: z.coerce.number().default(500),
  MAX_ELEMENTS: z.coerce.number().default(40),
  MAX_HISTORY_STEPS: z.coerce.number().default(10),

  VISION_MODE: z.enum(['always', 'fallback', 'never']).default('fallback'),
  LOG_DIR: z.string().default('logs'),

  /** Gemini API key for Stark vision (optional if GEMINI_API_KEY is set). */
  STARK_VISION_API_KEY: z.string().default(''),

  /** Shared Gemini key name — used by Stark when STARK_VISION_API_KEY is empty. */
  GEMINI_API_KEY: z.string().default(''),

  /**
   * Model id for StarkVisionClient (@google/genai). Empty = use LLM_MODEL when LLM_PROVIDER=gemini, else a built-in default.
   */
  STARK_VISION_MODEL: z.string().default(''),

  /**
   * Base URL for an OpenAI-compatible local vision server (e.g. LM Studio: http://127.0.0.1:1234).
   * When set, StarkVisionClient routes all calls through the local server instead of Google GenAI.
   * STARK_VISION_MODEL must also be set to the model name shown by the local server.
   */
  STARK_VISION_BASE_URL: z.string().default(''),

  /**
   * Coordinate order returned by the local vision model.
   * 'yx' (default): model returns [y, x] as the prompt instructs (Gemma, most models).
   * 'xy': model returns [x, y] despite the prompt (some Qwen variants).
   */
  STARK_VISION_COORDINATE_ORDER: z.enum(['yx', 'xy']).default('yx'),

  /** Agent interaction mode: "dom" uses DOM locators, "vision" uses AI vision as primary strategy */
  AGENT_MODE: z.enum(['dom', 'vision']).default('dom'),

  /**
   * Log Stark vision locate calls (`[vision-locate] stark-vision | …`).
   * Set to false to silence.
   */
  VISION_LOCATE_LOG: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** Per-step and run summary: token counts and estimated cost in the terminal. Set true to show. */
  SHOW_TOKEN_USAGE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** Enable extended thinking/reasoning for supported providers (anthropic, gemini, openai) */
  LLM_THINKING: z.enum(['on', 'off']).default('on'),
  /** Max tokens the model can use for thinking (budget). Higher = deeper reasoning but slower + more expensive. */
  LLM_THINKING_BUDGET: z.coerce.number().default(128),

  /**
   * If > 0, screenshots sent to the agent/planner LLM are downscaled so max(width,height) ≤ this value (aspect preserved).
   * Does not affect Stark vision or raw Appium captures — only multimodal model input. 0 = disabled.
   * Gemini bills images by resolution; try 384 (fewest image tokens) or 768 (balance).
   */
  LLM_SCREENSHOT_MAX_EDGE_PX: z.coerce.number().default(0),

  /** Episodic memory: persist successful trajectories across sessions. "on" to enable. */
  EPISODIC_MEMORY: z.enum(['on', 'off']).default('off'),

  /** Override path for episodic memory store. Empty = ~/.appclaw/trajectories.json */
  EPISODIC_MEMORY_PATH: z.string().default(''),

  // ── Cloud provider ──────────────────────────────────────────────────────────

  /** Cloud provider for remote device execution. Empty = local (default). */
  CLOUD_PROVIDER: z.enum(['', 'lambdatest']).default(''),

  /** LambdaTest account username (required when CLOUD_PROVIDER=lambdatest). */
  LAMBDATEST_USERNAME: z.string().default(''),

  /** LambdaTest access key (required when CLOUD_PROVIDER=lambdatest). */
  LAMBDATEST_ACCESS_KEY: z.string().default(''),

  /** Cloud device name, e.g. "iPhone 14" (required when CLOUD_PROVIDER=lambdatest). */
  LAMBDATEST_DEVICE_NAME: z.string().default(''),

  /** Cloud OS version, e.g. "16" (required when CLOUD_PROVIDER=lambdatest). */
  LAMBDATEST_OS_VERSION: z.string().default(''),

  /** LambdaTest build label shown in the dashboard. */
  LAMBDATEST_BUILD_NAME: z.string().default(''),

  /** LambdaTest project label shown in the dashboard. */
  LAMBDATEST_PROJECT_NAME: z.string().default(''),

  /** Record session video on LambdaTest. Default: true. */
  LAMBDATEST_VIDEO: z.enum(['true', 'false']).default('true'),

  /** Capture network logs on LambdaTest. Default: false. */
  LAMBDATEST_NETWORK: z.enum(['true', 'false']).default('false'),

  /** LambdaTest app ID (lt://APP...) — the app to install and test on the cloud device. */
  LAMBDATEST_APP: z.string().default(''),
});

export type AppClawConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppClawConfig {
  const config = envSchema.parse(process.env);
  if (config.CLOUD_PROVIDER === 'lambdatest') {
    if (!config.LAMBDATEST_USERNAME || !config.LAMBDATEST_ACCESS_KEY) {
      throw new Error(
        'LAMBDATEST_USERNAME and LAMBDATEST_ACCESS_KEY are required when CLOUD_PROVIDER=lambdatest'
      );
    }
    if (!config.LAMBDATEST_DEVICE_NAME || !config.LAMBDATEST_OS_VERSION) {
      throw new Error(
        'LAMBDATEST_DEVICE_NAME and LAMBDATEST_OS_VERSION are required when CLOUD_PROVIDER=lambdatest'
      );
    }
  }
  return config;
}

export const Config = loadConfig();
