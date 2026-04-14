/**
 * Step runner — executes a single natural-language instruction on device.
 *
 * Mirrors the playground's per-command execution path:
 *   instruction → tryParseNaturalFlowLine (regex, no LLM) → resolveNaturalStep (LLM fallback) → executeStep
 *
 * Single Responsibility: translate one natural-language string into a device action.
 */

import type { MCPClient } from '../mcp/types.js';
import type { RunArtifactCollector } from '../report/writer.js';
import { screenshot } from '../mcp/tools.js';
import { tryParseNaturalFlowLine } from '../flow/natural-line.js';
import { resolveNaturalStep } from '../flow/llm-parser.js';
import { executeStep } from '../flow/run-yaml-flow.js';
import type { RunResult } from './types.js';

const DEFAULT_TAP_POLL = { maxAttempts: 3, intervalMs: 300 };

export class StepRunner {
  constructor(
    private readonly mcp: MCPClient,
    private readonly collector?: RunArtifactCollector,
    private readonly stepIndex?: number
  ) {}

  async run(instruction: string): Promise<RunResult> {
    // 1. Try regex-based parsing first — no LLM cost for common patterns
    let step = tryParseNaturalFlowLine(instruction);

    // 2. Fall back to LLM interpretation for anything the regex can't handle
    if (!step) {
      const resolved = await resolveNaturalStep(instruction);
      step = resolved.step;
    }

    // 3. Mark step start for duration tracking
    if (this.collector && this.stepIndex !== undefined) {
      this.collector.startStep(this.stepIndex);
    }

    // 4. Execute on device
    const result = await executeStep(this.mcp, step, {}, undefined, DEFAULT_TAP_POLL);

    // 5. Record step + screenshot in report
    if (this.collector && this.stepIndex !== undefined) {
      this.collector.addStep({
        index: this.stepIndex,
        kind: step.kind,
        verbatim: instruction,
        phase: 'test',
        status: result.success ? 'passed' : 'failed',
        message: result.message,
        error: result.success ? undefined : result.message,
      });
      const screenshotB64 = await screenshot(this.mcp).catch(() => null);
      if (screenshotB64) {
        this.collector.attachScreenshot(this.stepIndex, screenshotB64);
      }
    }

    return {
      success: result.success,
      action: step.kind,
      message: result.message,
    };
  }
}
