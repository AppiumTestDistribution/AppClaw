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

  /**
   * Local file path or HTTP(S) URL to an APK/IPA to install at session start.
   * Passed as the `appium:app` capability so Appium downloads and installs it automatically.
   * Example: APP_PATH=/path/to/app.apk  or  APP_PATH=https://example.com/MyApp.apk
   * Can be overridden per-flow via the `app:` key in the YAML meta section.
   */
  APP_PATH: z.string().default(''),

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

  /**
   * Implicit wait for element readiness before an action (tap/type/verify/scroll)
   * is performed. The target is polled until it is present on screen or this
   * budget is exhausted — so callers don't need explicit `wait`/`wait until …`
   * steps between actions. Default 10 s. Set to 0 to disable implicit waiting
   * (single-shot, fail-fast). Applies to both DOM and vision modes.
   */
  WAIT_TIMEOUT: z.coerce.number().default(10_000),
  /** Poll cadence (ms) for the implicit wait above. Default 300 ms. */
  WAIT_INTERVAL: z.coerce.number().default(300),
  MAX_ELEMENTS: z.coerce.number().default(40),
  MAX_HISTORY_STEPS: z.coerce.number().default(10),
  /** Milliseconds before an LLM request is aborted. Default 60 s. Set to 0 to disable. */
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().default(60_000),

  VISION_MODE: z.enum(['always', 'fallback', 'never']).default('fallback'),
  LOG_DIR: z.string().default('logs'),

  /**
   * Default directory for exported SDK test specs (from `--export` and the
   * playground's `/export <name>.test.ts`). Bare filenames land here; paths
   * with a directory component (e.g. `./tests/foo.test.ts` or `/abs/path`)
   * are used verbatim. Override per-run via the `--export-dir` CLI flag.
   */
  EXPORT_DIR: z.string().default('.appclaw/exports'),

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
  /**
   * Gemini 2.5: thinking token budget (0 = off, -1 = dynamic per Google).
   * Gemini 3.x: prefer LLM_GEMINI_THINKING_LEVEL; budget is not sent for 3.x to avoid odd interactions on 3 Pro.
   * Anthropic: extended thinking budget.
   */
  LLM_THINKING_BUDGET: z.coerce.number().default(128),

  /**
   * Gemini 3.x only — reasoning depth (https://ai.google.dev/gemini-api/docs/thinking).
   * Ignored for Gemini 2.5 (those use LLM_THINKING_BUDGET).
   */
  LLM_GEMINI_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).default('medium'),

  /** When Gemini thinking is on, request thought summaries in the API stream (includeThoughts). */
  LLM_GEMINI_INCLUDE_THOUGHTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

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

  /**
   * Namespace scoping for episodic + procedural memory. Use to isolate stores
   * across users, CI lanes, branches, or test suites so memories never bleed
   * between contexts. Default "default" preserves single-user behavior.
   */
  APPCLAW_MEMORY_NAMESPACE: z.string().default('default'),

  /**
   * Override path for procedural memory store. Empty = ~/.appclaw/procedures.json.
   * Multi-step recipes recorded from successful runs and replayed as plans.
   */
  PROCEDURAL_MEMORY_PATH: z.string().default(''),

  /**
   * Rolling run summary: compress the agent's action history every N steps to
   * keep long runs (30+ steps) within the LLM context budget. 0 disables.
   */
  RUN_SUMMARY_EVERY_N_STEPS: z.coerce.number().default(8),

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

export function loadConfig(overrides?: Record<string, string | undefined>): AppClawConfig {
  const env = overrides ? { ...process.env, ...overrides } : process.env;
  const config = envSchema.parse(env);
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

/**
 * Re-read `process.env` into the shared `Config` singleton, mutating it in place.
 *
 * `Config` is computed once at import time (the line above). But the CLI loads a
 * `--env-file` into `process.env` at runtime — long after every module has already
 * imported `Config` by reference (run-yaml-flow, run-instruction, vision/locate-enabled,
 * agent/loop, …). Without this refresh those modules keep the import-time snapshot, so
 * `--env-file` values like `AGENT_MODE=vision` are silently ignored and execution falls
 * back to DOM mode.
 *
 * Mutating in place (rather than reassigning the `const`) means every existing importer
 * sees the merged values, because they all hold the same object reference. `loadConfig()`
 * always returns the full key set (zod defaults fill any gaps), so no stale keys survive.
 */
export function refreshConfig(): AppClawConfig {
  return Object.assign(Config, loadConfig());
}
