/**
 * Flow runner — executes a YAML flow file against a live device.
 *
 * Single Responsibility: parse the flow file and delegate execution
 * to the existing runYamlFlow engine.
 *
 * Open/Closed: extend via RunYamlFlowOptions callbacks (onFlowStep,
 * artifactCollector) without modifying this class.
 */

import { parseFlowYamlFile } from '../flow/parse-yaml-flow.js';
import { runYamlFlow, type RunYamlFlowOptions } from '../flow/run-yaml-flow.js';
import type { MCPClient } from '../mcp/types.js';
import type { FlowResult } from './types.js';

export class FlowRunner {
  private readonly mcp: MCPClient;

  constructor(mcp: MCPClient) {
    this.mcp = mcp;
  }

  /**
   * Parse and execute a YAML flow file.
   *
   * @param flowPath - Absolute or relative path to the .yaml flow file.
   * @param options  - Optional overrides forwarded to the flow engine
   *                   (step delay, callbacks, artifact collection, etc.).
   */
  async run(flowPath: string, options: RunYamlFlowOptions = {}): Promise<FlowResult> {
    const { meta, steps, phases } = await parseFlowYamlFile(flowPath);

    const result = await runYamlFlow(this.mcp, meta, steps, options, phases);

    return {
      success: result.success,
      stepsUsed: result.stepsExecuted,
      stepsTotal: result.stepsTotal,
      failedStep: result.failedAt,
      failedPhase: result.failedPhase,
      error: result.reason,
    };
  }
}
