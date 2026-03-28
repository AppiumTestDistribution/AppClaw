import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  LLM_PROVIDER: z.enum(["anthropic", "openai", "gemini", "groq", "ollama"]).default("anthropic"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default(""),

  MCP_TRANSPORT: z.enum(["stdio", "sse"]).default("stdio"),
  MCP_HOST: z.string().default("localhost"),
  MCP_PORT: z.coerce.number().default(8080),

  /**
   * Android UiAutomator2: appium:mjpegScreenshotUrl — MJPEG stream URL for faster screenshots.
   * Default: http://127.0.0.1:7810 (matches default mjpegServerPort).
   */
  APPIUM_MJPEG_SCREENSHOT_URL: z.string().default("http://127.0.0.1:7810"),

  /**
   * Android UiAutomator2: appium:mjpegServerPort — port for the MJPEG screenshot server.
   * Default: 7810. Set to 0 to disable MJPEG and use normal screenshots.
   */
  APPIUM_MJPEG_SERVER_PORT: z.coerce.number().default(7810),

  MAX_STEPS: z.coerce.number().default(30),
  STEP_DELAY: z.coerce.number().default(500),
  MAX_ELEMENTS: z.coerce.number().default(40),
  MAX_HISTORY_STEPS: z.coerce.number().default(10),

  VISION_MODE: z.enum(["always", "fallback", "never"]).default("fallback"),
  LOG_DIR: z.string().default("logs"),

  /**
   * Where natural-language visual locate resolves to coordinates.
   * - stark: df-vision + Gemini (screenshot in-process; tap via appium-mcp).
   * - appium_mcp: appium_find_element with strategy ai_instruction (MCP server vision).
   */
  VISION_LOCATE_PROVIDER: z.enum(["stark", "appium_mcp"]).default("appium_mcp"),

  /** Gemini API key for Stark vision (optional if GEMINI_API_KEY is set). */
  STARK_VISION_API_KEY: z.string().default(""),

  /** Shared Gemini key name — used by Stark when STARK_VISION_API_KEY is empty. */
  GEMINI_API_KEY: z.string().default(""),

  /**
   * Model id for StarkVisionClient (@google/genai). Empty = use LLM_MODEL when LLM_PROVIDER=gemini, else a built-in default.
   */
  STARK_VISION_MODEL: z.string().default(""),

  /** Agent interaction mode: "dom" uses DOM locators, "vision" uses AI vision as primary strategy */
  AGENT_MODE: z.enum(["dom", "vision"]).default("dom"),

  /**
   * Log which vision backend is used for each NL locate (`[vision-locate] stark-vision | …` or `mcp vision | …`).
   * Set to false to silence.
   */
  VISION_LOCATE_LOG: z.enum(["true", "false"]).default("true").transform(v => v === "true"),

  /** Per-step and run summary: token counts and estimated cost in the terminal. Set true to show. */
  SHOW_TOKEN_USAGE: z.enum(["true", "false"]).default("false").transform(v => v === "true"),

  /** AI Vision via appium-mcp ai_instruction (when VISION_LOCATE_PROVIDER=appium_mcp) */
  AI_VISION_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  AI_VISION_API_BASE_URL: z.string().default(""),
  AI_VISION_API_KEY: z.string().default(""),
  AI_VISION_MODEL: z.string().default(""),
  AI_VISION_COORD_TYPE: z.enum(["normalized", "absolute"]).default("normalized"),

  /** Enable extended thinking/reasoning for supported providers (anthropic, gemini, openai) */
  LLM_THINKING: z.enum(["on", "off"]).default("on"),
  /** Max tokens the model can use for thinking (budget). Higher = deeper reasoning but slower + more expensive. */
  LLM_THINKING_BUDGET: z.coerce.number().default(128),

  /**
   * If > 0, screenshots sent to the agent/planner LLM are downscaled so max(width,height) ≤ this value (aspect preserved).
   * Does not affect Stark vision or raw Appium captures — only multimodal model input. 0 = disabled.
   * Gemini bills images by resolution; try 384 (fewest image tokens) or 768 (balance).
   */
  LLM_SCREENSHOT_MAX_EDGE_PX: z.coerce.number().default(0),

  /** Episodic memory: persist successful trajectories across sessions. "on" to enable. */
  EPISODIC_MEMORY: z.enum(["on", "off"]).default("off"),

  /** Override path for episodic memory store. Empty = ~/.appclaw/trajectories.json */
  EPISODIC_MEMORY_PATH: z.string().default(""),
});

export type AppClawConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppClawConfig {
  return envSchema.parse(process.env);
}

export const Config = loadConfig();
