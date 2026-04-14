/**
 * Public-facing types for the AppClaw SDK.
 *
 * All interfaces that consumers of `appclaw` import live here.
 * Internal implementation types stay in their respective modules.
 */

export type LLMProvider = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'ollama';
export type AgentMode = 'dom' | 'vision';
export type MCPTransport = 'stdio' | 'sse';
export type Platform = 'android' | 'ios';

/**
 * Options accepted by the AppClaw constructor.
 * All fields are optional — unset fields fall back to environment variables
 * or AppClaw defaults, matching CLI behaviour.
 */
export interface AppClawOptions {
  /** LLM provider to use. Default: 'gemini'. */
  provider?: LLMProvider;
  /** API key for the chosen provider. */
  apiKey?: string;
  /** Model ID override (e.g. 'claude-opus-4-6'). Defaults to the provider's recommended model. */
  model?: string;
  /** Target mobile platform. */
  platform?: Platform;
  /** Interaction strategy: DOM locators (default) or AI vision. */
  agentMode?: AgentMode;
  /** Maximum number of agent steps before giving up. Default: 30. */
  maxSteps?: number;
  /** Delay between steps in milliseconds. Default: 500. */
  stepDelay?: number;
  /**
   * Suppress all terminal output (spinners, colours, progress).
   * Defaults to true in SDK mode — set false to re-enable for debugging.
   */
  silent?: boolean;
  /**
   * Automatically generate an HTML report to .appclaw/runs/ on teardown.
   * Defaults to true — set false to disable.
   */
  report?: boolean;
  /** Name shown in the report viewer. Default: 'AppClaw SDK Run'. */
  reportName?: string;
  /** How to connect to appium-mcp. Default: 'stdio'. */
  mcpTransport?: MCPTransport;
  /** appium-mcp host when transport is 'sse'. Default: 'localhost'. */
  mcpHost?: string;
  /** appium-mcp port when transport is 'sse'. Default: 8080. */
  mcpPort?: number;
}

/** Result returned by AppClaw.runFlow() */
export interface FlowResult {
  success: boolean;
  /** Number of flow steps executed. */
  stepsUsed: number;
  /** Total steps in the flow (including unexecuted ones). */
  stepsTotal: number;
  /** 1-based index of the step that failed (if any). */
  failedStep?: number;
  /** Which phase failed ('setup' | 'test' | 'assertion'), for phased flows. */
  failedPhase?: string;
  /** Human-readable failure reason. */
  error?: string;
}

/** Result returned by AppClaw.run() — a single natural-language instruction executed on device. */
export interface RunResult {
  success: boolean;
  /** The resolved step kind (tap, type, openApp, wait, …). */
  action: string;
  /** Human-readable description of what happened. */
  message: string;
}

// Re-export core agent result so consumers get a single import surface.
export type { AgentResult } from '../agent/loop.js';
