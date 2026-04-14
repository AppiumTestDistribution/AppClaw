/**
 * Goal runner — executes a natural-language goal against a live device.
 *
 * Single Responsibility: wire together the LLM provider and agent loop
 * for a single goal execution.
 *
 * Depends on MCPClient and MCPToolInfo interfaces (not concretions),
 * satisfying the Dependency Inversion Principle.
 */

import { runAgent, type AgentResult } from '../agent/loop.js';
import { createLLMProvider } from '../llm/provider.js';
import type { MCPClient, MCPToolInfo } from '../mcp/types.js';
import type { AppClawConfig } from '../config.js';

export class GoalRunner {
  private readonly mcp: MCPClient;
  private readonly tools: MCPToolInfo[];
  private readonly config: AppClawConfig;

  constructor(mcp: MCPClient, tools: MCPToolInfo[], config: AppClawConfig) {
    this.mcp = mcp;
    this.tools = tools;
    this.config = config;
  }

  /**
   * Execute a natural-language goal.
   *
   * A fresh LLM provider is created per call so history does not leak
   * across independent goal executions.
   */
  async run(goal: string): Promise<AgentResult> {
    const llm = createLLMProvider(this.config, this.tools);

    return runAgent({
      goal,
      mcp: this.mcp,
      llm,
      maxSteps: this.config.MAX_STEPS,
      stepDelay: this.config.STEP_DELAY,
      visionMode: this.config.VISION_MODE,
    });
  }
}
