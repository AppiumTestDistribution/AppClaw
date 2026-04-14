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

import { buildConfig } from './config-builder.js';
import { McpSession } from './mcp-session.js';
import { FlowRunner } from './flow-runner.js';
import { GoalRunner } from './goal-runner.js';
import { StepRunner } from './step-runner.js';
import { RunArtifactCollector } from '../report/writer.js';
import { silenceTerminalUI } from '../ui/terminal.js';
import type { RunYamlFlowOptions, RunYamlFlowResult } from '../flow/run-yaml-flow.js';
import type { AppClawOptions, FlowResult, RunResult } from './types.js';
import type { AgentResult } from '../agent/loop.js';

export class AppClaw {
  private readonly session: McpSession;
  private readonly config: ReturnType<typeof buildConfig>;

  // ── Report state ───────────────────────────────────────────
  private readonly collector: RunArtifactCollector | null;
  private runStepCounter = 0;
  private runSuccess = true;
  private runFailedAt: number | undefined;
  private runFailureReason: string | undefined;

  constructor(options: AppClawOptions = {}) {
    this.config = buildConfig(options);
    this.session = new McpSession(this.config);

    // Silent by default in SDK mode — no spinners or ANSI colours in CI logs.
    if (options.silent !== false) {
      silenceTerminalUI();
    }

    // Report enabled by default — written to .appclaw/runs/ on teardown.
    this.collector =
      options.report !== false
        ? new RunArtifactCollector(
            'sdk-run',
            { name: options.reportName ?? 'AppClaw SDK Run' },
            (options.platform ?? 'android') as 'android' | 'ios'
          )
        : null;
  }

  /**
   * Execute a single natural-language instruction on the device.
   *
   * Equivalent to the playground's per-command execution: the instruction is
   * interpreted (regex → LLM fallback) and executed immediately as one step.
   * Each call is captured as a step in the auto-generated report.
   *
   * @param instruction - e.g. "open YouTube app", "tap Search", "type Appium 3.0"
   */
  async run(instruction: string): Promise<RunResult> {
    const { client } = await this.session.connect();
    const stepIndex = ++this.runStepCounter;
    const runner = new StepRunner(client, this.collector ?? undefined, stepIndex);
    const result = await runner.run(instruction);

    // Track first failure for report finalization
    if (!result.success && this.runSuccess) {
      this.runSuccess = false;
      this.runFailedAt = stepIndex;
      this.runFailureReason = result.message;
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
   * @param goal - Plain English description of what to accomplish on the device.
   */
  async runGoal(goal: string): Promise<AgentResult> {
    const { client, tools } = await this.session.connect();
    const runner = new GoalRunner(client, tools, this.config);
    return runner.run(goal);
  }

  /**
   * Close the MCP connection and release all resources.
   * Writes the report to .appclaw/runs/ if report is enabled (default).
   * Call this in afterAll() / test teardown hooks.
   */
  async teardown(): Promise<void> {
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
export type { AppClawOptions, FlowResult, RunResult, AgentResult } from './types.js';
export type { RunYamlFlowOptions } from '../flow/run-yaml-flow.js';
