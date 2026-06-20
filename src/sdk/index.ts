/**
 * AppClaw SDK — public entry point.
 *
 * Usage:
 *   import { AppClaw } from 'appclaw'
 *
 *   const app = new AppClaw({ provider: 'anthropic', apiKey: process.env.KEY })
 *   await app.run('open YouTube app')
 *   await app.run('tap Search')
 *   await app.teardown()   // report written to .appclaw/runs/
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { buildConfig } from './config-builder.js';
import { applyConfig } from '../config.js';
import { McpSession } from './mcp-session.js';
import { FlowRunner } from './flow-runner.js';
import { GoalRunner } from './goal-runner.js';
import { StepRunner } from './step-runner.js';
import { snapshotVisibleTexts } from './screen-snapshot.js';
import {
  generateSdkTest,
  keepOnlyFinalAttempt,
  type GenerateSdkTestConfig,
} from './goal-export.js';
import { RunArtifactCollector } from '../report/writer.js';
import { silenceTerminalUI } from '../ui/terminal.js';
import type {
  RunYamlFlowOptions,
  RunYamlFlowResult,
  FlowTapPollOptions,
} from '../flow/run-yaml-flow.js';
import { AppClawAssertionError, AppClawStepError } from './types.js';
import type { AppClawOptions, FlowResult, RunResult, RunOptions } from './types.js';
import type { ScrollControl } from '../flow/run-yaml-flow.js';
import type { AgentResult } from '../agent/loop.js';

/**
 * Convert a (timeout, interval) pair into the engine's poll budget.
 * `timeout <= 0` → a single attempt (fail-fast). Interval is floored at 1ms to
 * avoid divide-by-zero.
 */
function toPollBudget(timeout: number, interval: number): FlowTapPollOptions {
  const intervalMs = Math.max(1, interval);
  const maxAttempts = timeout <= 0 ? 1 : Math.max(1, Math.ceil(timeout / intervalMs));
  return { maxAttempts, intervalMs };
}

export class AppClaw {
  private readonly session: McpSession;
  private readonly config: ReturnType<typeof buildConfig>;

  // ── Report state ───────────────────────────────────────────
  private readonly collector: RunArtifactCollector | null;
  private readonly videoEnabled: boolean;
  private readonly silent: boolean;
  private readonly failOnError: boolean;
  /** Implicit-wait poll budget applied to every element-bearing action. */
  private readonly tapPoll: FlowTapPollOptions;
  /** Instance-default implicit-wait settings, used to derive per-call budgets. */
  private readonly waitTimeout: number;
  private readonly waitInterval: number;
  /** Instance-default scroll/swipe overrides (undefined → engine/parsed defaults). */
  private readonly scrollMode?: AppClawOptions['scrollMode'];
  private readonly scrollTimes?: number;
  private runStepCounter = 0;
  private runSuccess = true;
  private runFailedAt: number | undefined;
  private runFailureReason: string | undefined;
  private recordingStarted = false;

  constructor(options: AppClawOptions = {}) {
    // Honour explicit mcpDebug option by flipping the env var BEFORE any MCP module
    // reads it. mcp/client.ts re-evaluates this on every log call so the flip takes
    // effect immediately, even though the module is already loaded.
    if (options.mcpDebug === false) {
      delete process.env.MCP_DEBUG;
    } else if (options.mcpDebug === true) {
      process.env.MCP_DEBUG = '1';
    }

    this.config = buildConfig(options);
    // Sync the shared Config singleton with this instance's options. The execution
    // pipeline (run-yaml-flow, run-instruction, vision/locate-enabled, agent/loop) reads
    // the global Config by reference, so without this, options set purely via the
    // constructor — e.g. `new AppClaw({ agentMode: 'vision' })` — would be ignored and
    // every command would silently run in DOM mode. (With multiple instances in one
    // process the last constructed config wins, same as the pre-existing singleton.)
    applyConfig(this.config);
    this.session = new McpSession(this.config);

    // `silent` controls per-step log lines (✓ #1 tap "label" ...). Default is
    // FALSE — most SDK consumers want to see what's happening on the device,
    // matching the playground's UX. Pass `silent: true` for a quiet test run.
    // The legacy --json-mode terminal suppression still runs when JSON mode is
    // enabled regardless, so JSON consumers stay clean.
    this.silent = options.silent === true;
    if (options.silent === true) {
      silenceTerminalUI();
    }

    // `failOnError` controls whether `app.run()` throws on a failed step. Default
    // true — a failed tap/type halts the test, matching most testing-framework
    // expectations. `verify()` always throws regardless of this flag.
    this.failOnError = options.failOnError !== false;

    // Report enabled by default — written to .appclaw/runs/ on teardown.
    this.collector =
      options.report !== false
        ? new RunArtifactCollector(
            'sdk-run',
            { name: options.reportName ?? 'AppClaw SDK Run' },
            (options.platform ?? 'android') as 'android' | 'ios'
          )
        : null;

    this.videoEnabled = options.video === true;

    // Implicit wait: poll the target until it's ready (present on screen) before
    // each action, so callers don't need explicit `wait …` steps between runs.
    this.waitTimeout = this.config.WAIT_TIMEOUT;
    this.waitInterval = this.config.WAIT_INTERVAL;
    this.tapPoll = toPollBudget(this.waitTimeout, this.waitInterval);

    // Instance-default scroll/swipe overrides — per-call run() options win over these.
    this.scrollMode = options.scrollMode;
    this.scrollTimes = options.scrollTimes;
  }

  /**
   * Execute a single natural-language instruction on the device.
   *
   * Equivalent to the playground's per-command execution: the instruction is
   * interpreted (regex → LLM fallback) and executed immediately as one step.
   * Each call is captured as a step in the auto-generated report.
   *
   * @param instruction - e.g. "open YouTube app", "tap Search", "type Appium 3.0"
   * @param options     - Optional per-command overrides (wait budget, scroll distance/count)
   *                      that win over the instance defaults for this call only.
   */
  async run(instruction: string, options: RunOptions = {}): Promise<RunResult> {
    const { client, appResolver } = await this.session.connect();

    // Start screen recording on the first step (best-effort — mirrors the YAML flow path)
    if (!this.recordingStarted && this.videoEnabled) {
      try {
        await client.callTool('appium_screen_recording', { action: 'start' });
        this.recordingStarted = true;
      } catch {
        /* appium version or driver may not support recording — skip silently */
      }
    }

    // Merge per-call overrides over the instance defaults. A per-call wait value
    // re-derives the poll budget for this step only; scroll overrides fall back
    // to the instance defaults, then to whatever the instruction parsed to.
    const tapPoll =
      options.waitTimeout !== undefined || options.waitInterval !== undefined
        ? toPollBudget(
            options.waitTimeout ?? this.waitTimeout,
            options.waitInterval ?? this.waitInterval
          )
        : this.tapPoll;

    const scrollMode = options.scrollMode ?? this.scrollMode;
    const scrollTimes = options.scrollTimes ?? this.scrollTimes;
    const scroll: ScrollControl | undefined =
      scrollMode !== undefined || scrollTimes !== undefined
        ? { distance: scrollMode, times: scrollTimes }
        : undefined;

    const stepIndex = ++this.runStepCounter;
    const runner = new StepRunner(
      client,
      this.collector ?? undefined,
      stepIndex,
      appResolver,
      this.silent,
      tapPoll,
      scroll
    );
    const result = await runner.run(instruction);

    // Track first failure for report finalization
    if (!result.success && this.runSuccess) {
      this.runSuccess = false;
      this.runFailedAt = stepIndex;
      this.runFailureReason = result.message;
    }

    // Default: throw on failure so the surrounding test framework fails the
    // test and the next step doesn't fire on top of a broken screen. Skipped
    // when the caller is `verify()` — that path handles its own error class.
    if (!result.success && this.failOnError && !this.suppressFailThrow) {
      throw new AppClawStepError(instruction, result);
    }

    return result;
  }

  /**
   * Internal flag set by `verify()` to bypass the generic step-failure throw —
   * `verify()` constructs its own richer `AppClawAssertionError` instead.
   */
  private suppressFailThrow = false;

  /**
   * Assert that something is on screen. Throws `AppClawAssertionError` on failure
   * so the surrounding test framework (vitest/jest/mocha) marks the test as failed.
   *
   * Accepts either a bare claim or a full assertion phrase — both are normalized
   * to a `verify ...` step before execution:
   *   app.verify('the screen has video uploaded by TestMu AI')
   *   app.verify('verify if the screen has video uploaded by TestMu AI')
   */
  async verify(instruction: string): Promise<RunResult> {
    const trimmed = instruction.trim();
    const hasPrefix = /^(?:assert|verify|check)\b/i.test(trimmed);
    const normalized = hasPrefix ? trimmed : `verify ${trimmed}`;
    // Use the bare claim (without assert/verify/check prefix or filler) in the
    // error message so it reads naturally regardless of how the caller phrased it.
    const claim = trimmed.replace(/^(?:assert|verify|check)\s+(?:that\s+|if\s+)?/i, '').trim();
    // Suppress the generic step-failure throw inside `run()` — we want to construct
    // a richer AppClawAssertionError (with claim, screen contents, etc.) instead.
    this.suppressFailThrow = true;
    let result: RunResult;
    try {
      result = await this.run(normalized);
    } finally {
      this.suppressFailThrow = false;
    }
    if (!result.success) {
      // In vision mode, the LLM's explanation already describes what is on screen
      // (it's embedded in result.message), so a DOM snapshot would be redundant.
      // Only fetch the DOM page-source as a fallback debug aid in DOM mode.
      let screenContents: string[] = [];
      if (this.config.AGENT_MODE !== 'vision') {
        const { client } = await this.session.connect();
        screenContents = await snapshotVisibleTexts(client);
      }
      throw new AppClawAssertionError(claim, result, screenContents);
    }
    return result;
  }

  /**
   * Parse and execute a YAML flow file.
   *
   * The MCP connection is established on the first call and reused for all
   * subsequent calls on this instance.
   *
   * @param flowPath  - Path to the .yaml flow file (absolute or relative to cwd).
   * @param options   - Optional flow engine overrides (step delay, callbacks, etc.).
   */
  async runFlow(flowPath: string, options: RunYamlFlowOptions = {}): Promise<FlowResult> {
    const { client } = await this.session.connect();
    const runner = new FlowRunner(client);
    return runner.run(flowPath, options);
  }

  /**
   * Execute a natural-language goal.
   *
   * @param goal     - Plain English description of what to accomplish on the device.
   * @param options  - Optional. Pass `exportPath` to write the agent's trajectory as a
   *                   replayable vitest spec at that path once the run completes. The
   *                   exported spec uses the same `provider`/`platform`/`agentMode` as
   *                   this instance, with `app.run(...)` calls per recorded step.
   */
  async runGoal(
    goal: string,
    options: { exportPath?: string; exportConfig?: GenerateSdkTestConfig } = {}
  ): Promise<AgentResult> {
    const { client, tools } = await this.session.connect();
    const runner = new GoalRunner(client, tools, this.config);
    const result = await runner.run(goal);

    if (options.exportPath) {
      const exportConfig: GenerateSdkTestConfig = {
        provider: this.config.LLM_PROVIDER,
        platform: this.config.PLATFORM,
        agentMode: this.config.AGENT_MODE,
        ...options.exportConfig,
      };
      // SDK runs a single agent (no sub-goal decomposition), so a single
      // keepOnlyFinalAttempt pass over the full history is the correct trim.
      const trimmedResult = { ...result, history: keepOnlyFinalAttempt(result.history) };
      const source = generateSdkTest({ goal, result: trimmedResult, config: exportConfig });
      await fs.mkdir(path.dirname(path.resolve(options.exportPath)), { recursive: true });
      await fs.writeFile(options.exportPath, source, 'utf8');
    }

    return result;
  }

  /**
   * Close the MCP connection and release all resources.
   * Writes the report to .appclaw/runs/ if report is enabled (default).
   * Call this in afterAll() / test teardown hooks.
   */
  async teardown(): Promise<void> {
    // Stop recording and attach to report before finalizing (MCP client must still be active)
    if (this.recordingStarted && this.videoEnabled && this.collector) {
      try {
        const { client } = await this.session.connect();
        const stopResult = await client.callTool('appium_screen_recording', { action: 'stop' });
        const textContent = stopResult.content?.find((c: any) => c.type === 'text');
        const text = (textContent?.type === 'text' ? textContent.text : '')?.trim() ?? '';
        const match = text.match(/saved to:\s*(.+\.mp4)/i);
        if (match?.[1]) this.collector.attachVideoFromPath(match[1].trim());
      } catch {
        /* ignore — report will just not have a video */
      }
    }

    if (this.collector && this.runStepCounter > 0) {
      const flowResult: RunYamlFlowResult = {
        success: this.runSuccess,
        stepsExecuted: this.runStepCounter,
        stepsTotal: this.runStepCounter,
        failedAt: this.runFailedAt,
        reason: this.runFailureReason,
      };
      await this.collector.finalize(process.cwd(), flowResult);
    }
    await this.session.release();
  }
}

// ── Public type exports ─────────────────────────────────────────────────────
export { AppClawAssertionError, AppClawStepError } from './types.js';
export type {
  AppClawOptions,
  FlowResult,
  RunResult,
  RunOptions,
  ScrollDistance,
  AgentResult,
} from './types.js';
export type { RunYamlFlowOptions } from '../flow/run-yaml-flow.js';
export {
  generateSdkTest,
  generateSdkTestFromInstructions,
  instructionsFromHistory,
  decisionToInstruction,
  keepOnlyFinalAttempt,
} from './goal-export.js';
export type { GenerateSdkTestConfig } from './goal-export.js';
