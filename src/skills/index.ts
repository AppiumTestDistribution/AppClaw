/**
 * Skill router — maps skill names to multi-step compound actions.
 *
 * Skills are sequences of MCP tool calls that accomplish common
 * multi-step tasks more reliably than letting the LLM decide each sub-step.
 */

import type { MCPClient } from '../mcp/types.js';
import type { ActionResult } from '../llm/schemas.js';
import { readScreen } from './read-screen.js';
import { findAndTap } from './find-and-tap.js';
import { submitMessage } from './submit-message.js';

export type SkillName = 'read_screen' | 'find_and_tap' | 'submit_message';

export interface SkillParams {
  query?: string;
  text?: string;
  direction?: string;
  maxScrolls?: number;
}

/** Execute a named skill with parameters. Returns ActionResult. */
export async function executeSkill(
  mcp: MCPClient,
  skill: SkillName,
  params: SkillParams
): Promise<ActionResult> {
  switch (skill) {
    case 'read_screen':
      return readScreen(mcp, params.maxScrolls);

    case 'find_and_tap':
      if (!params.query) {
        return { success: false, message: "find_and_tap requires a 'query' parameter" };
      }
      return findAndTap(mcp, params.query, params.direction, params.maxScrolls);

    case 'submit_message':
      return submitMessage(mcp);

    default:
      return { success: false, message: `Unknown skill: ${skill}` };
  }
}

/** Check if an action name is a skill */
export function isSkill(action: string): action is SkillName {
  return ['read_screen', 'find_and_tap', 'submit_message'].includes(action);
}
