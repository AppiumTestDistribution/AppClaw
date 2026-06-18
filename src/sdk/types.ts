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
 * How far each scroll/swipe gesture travels, as a fraction of the screen:
 * `short` ≈ 30%, `medium` ≈ 60% (the engine default), `full` ≈ 90%.
 */
export type ScrollDistance = 'short' | 'medium' | 'full';

/**
 * Per-command overrides for a single `app.run(instruction, options)` call.
 * Any field left unset falls back to the value configured on the AppClaw
 * instance (constructor options / env). These let you tune one step without
 * changing the instance defaults — e.g. a longer wait for a slow screen, or a
 * shorter scroll for a tight list.
 */
export interface RunOptions {
  /** Implicit wait (ms) for this command's target element. Overrides the instance `waitTimeout`. */
  waitTimeout?: number;
  /** Poll cadence (ms) for this command's implicit wait. Overrides the instance `waitInterval`. */
  waitInterval?: number;
  /** Distance each scroll/swipe travels for this command. Applies to `scroll …`/`swipe …` steps. */
  scrollMode?: ScrollDistance;
  /**
   * How many times to scroll/swipe for this command. For `scroll … until <text>`
   * steps this caps the scroll attempts (maxScrolls); for plain `swipe <dir>` it
   * sets the repeat count. Overrides any count parsed from the instruction.
   */
  scrollTimes?: number;
}

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
  /**
   * Target a specific device by UDID (Android serial or iOS UDID).
   * Required when running tests in parallel so each instance targets a different device.
   * Get Android UDIDs from: adb devices
   */
  deviceUdid?: string;
  /** Interaction strategy: DOM locators (default) or AI vision. */
  agentMode?: AgentMode;
  /** Maximum number of agent steps before giving up. Default: 30. */
  maxSteps?: number;
  /** Delay between steps in milliseconds. Default: 500. */
  stepDelay?: number;
  /**
   * Implicit wait (ms) for an element to be ready before each action
   * (tap/type/verify/scroll). The target is polled until it appears on screen
   * or this budget is exhausted — so you don't need explicit `wait …` steps
   * between actions. Default: 10000. Set to 0 to disable (fail-fast, single
   * attempt). Applies to both DOM and vision modes.
   */
  waitTimeout?: number;
  /** Poll cadence (ms) for `waitTimeout`. Default: 300. */
  waitInterval?: number;
  /**
   * Default scroll/swipe distance for every `scroll …`/`swipe …` step on this
   * instance. Per-command override via `app.run(instr, { scrollMode })`.
   * Unset → the engine default (~60% of the screen).
   */
  scrollMode?: ScrollDistance;
  /**
   * Default scroll/swipe repeat count for this instance. Per-command override
   * via `app.run(instr, { scrollTimes })`. Unset → the count parsed from the
   * instruction (e.g. "scroll down 3 times"), else 1 swipe / 3 scroll attempts.
   */
  scrollTimes?: number;
  /**
   * Suppress per-step log lines (`✓ #1 tap "search icon"` etc.).
   * Defaults to `false` — SDK consumers see device activity by default,
   * matching the playground's UX. Set `true` for a quiet test run where the
   * surrounding framework (vitest/jest) already reports per-test outcomes.
   */
  silent?: boolean;
  /**
   * Whether `app.run()` throws `AppClawStepError` on a failed step.
   * Defaults to `true` — a failed tap/type/swipe halts the test, the way most
   * test frameworks expect. Set `false` if you want to inspect `result.success`
   * yourself or continue past best-effort steps (e.g. dismissing a maybe-present
   * dialog). `app.verify()` always throws on failure regardless of this option.
   */
  failOnError?: boolean;
  /**
   * Automatically generate an HTML report to .appclaw/runs/ on teardown.
   * Defaults to true — set false to disable.
   */
  report?: boolean;
  /** Name shown in the report viewer. Default: 'AppClaw SDK Run'. */
  reportName?: string;
  /**
   * Record the screen during the run and embed the video in the report.
   * Requires Appium to support `appium_screen_recording`. Default: false.
   */
  video?: boolean;
  /** How to connect to appium-mcp. Default: 'stdio'. */
  mcpTransport?: MCPTransport;
  /** appium-mcp host when transport is 'sse'. Default: 'localhost'. */
  mcpHost?: string;
  /** appium-mcp port when transport is 'sse'. Default: 8080. */
  mcpPort?: number;
  /**
   * Stream verbose appium-mcp logs (subprocess stderr + per-tool timing) to the console.
   * When `false`, suppresses these even if the `MCP_DEBUG=1` env var is set — useful for
   * keeping test output clean. When `true`, forces them on. When unset, defers to MCP_DEBUG.
   */
  mcpDebug?: boolean;
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

/**
 * Thrown by `AppClaw.run()` when a step fails (e.g. element not located,
 * type into missing field, tap failed). Lets the surrounding test framework
 * (vitest/jest/mocha) mark the test red without callers having to inspect
 * `RunResult.success` after every call.
 *
 * Opt out by constructing `AppClaw` with `{ failOnError: false }` — then
 * `app.run()` returns the failed RunResult instead of throwing.
 *
 * Note: `verify()` uses a separate error class (`AppClawAssertionError`)
 * because assertion failures carry extra context (the bare claim, the LLM's
 * vision reason, etc.) that don't apply to generic step failures.
 */
export class AppClawStepError extends Error {
  /** The natural-language instruction that failed. */
  readonly instruction: string;
  /** The underlying step result returned by the engine. */
  readonly result: RunResult;
  constructor(instruction: string, result: RunResult) {
    const reason = result.message?.trim() || 'step failed';
    super(`Step failed: "${instruction}"\n  Reason: ${reason}`);
    this.name = 'AppClawStepError';
    this.instruction = instruction;
    this.result = result;
  }
}

/**
 * Thrown by `AppClaw.verify()` when an on-device assertion fails.
 * Carries the original claim, the underlying `RunResult`, and a snapshot of
 * the visible text on screen at the moment of failure so users can see at a
 * glance why the assertion didn't hold.
 */
export class AppClawAssertionError extends Error {
  /** The user's original claim, e.g. "the screen has video uploaded by TestMu AI". */
  readonly claim: string;
  /** The underlying step result returned by the engine. */
  readonly result: RunResult;
  /** Visible texts captured from the device DOM at the moment of failure (empty if unavailable). */
  readonly screenContents: string[];
  constructor(claim: string, result: RunResult, screenContents: string[] = []) {
    // Strip the engine's redundant "Assertion failed:" prefix — we already say "Verify failed" on the first line.
    const reason =
      (result.message ?? '').replace(/^Assertion failed:\s*/i, '').trim() ||
      'not verified on screen';
    // Only render the "On screen now" block when we actually captured a DOM snapshot.
    // In vision mode the reason itself already describes what is on screen, so we skip it.
    const onScreen = screenContents.length
      ? `\n  On screen now:\n${screenContents.map((t) => `    • ${t}`).join('\n')}`
      : '';
    super(`Verify failed: "${claim}"\n  Reason: ${reason}${onScreen}`);
    this.name = 'AppClawAssertionError';
    this.claim = claim;
    this.result = result;
    this.screenContents = screenContents;
  }
}
