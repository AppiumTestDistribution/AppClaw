/**
 * Converts MCP tool schemas into Vercel AI SDK tool definitions.
 *
 * This allows the LLM to dynamically discover and call any tool
 * exposed by appium-mcp — no hardcoded tool names or switch statements.
 */

import { tool, jsonSchema, type Tool } from 'ai';
import type { MCPToolInfo } from './types.js';

/**
 * Convert an array of MCP tool descriptors into a Vercel AI SDK tools map.
 * Each MCP tool becomes a tool the LLM can call directly by name.
 *
 * Tools are created WITHOUT execute functions — execution is handled
 * by the agent loop via mcpClient.callTool().
 */
export function convertMCPToolsToAITools(
  mcpTools: MCPToolInfo[],
  excludeNames?: Set<string>
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};

  for (const mcpTool of mcpTools) {
    // Skip excluded tools (e.g., session management tools the agent shouldn't call)
    if (excludeNames?.has(mcpTool.name)) continue;

    const description = mcpTool.description ?? mcpTool.name;
    const schema = mcpTool.inputSchema ?? { type: 'object' as const, properties: {} };

    tools[mcpTool.name] = tool({
      description,
      inputSchema: jsonSchema(schema as any),
    });
  }

  return tools;
}

/** MCP tools the agent should never call directly */
export const EXCLUDED_MCP_TOOLS = new Set([
  'create_session',
  'delete_session',
  'list_sessions',
  'selectSession',
  'select_platform',
  'select_device',
  'setup_wda',
  'install_wda',
  'boot_simulator',
  // AI code-gen tools — not relevant to device control
  'appium_generate_tests',
  'appium_generate_locators',
  'generate_tests',
  'generate_locators',
]);

/** Additional tools to exclude in vision mode — DOM-based tools that distract the agent */
export const VISION_MODE_EXCLUDED_TOOLS = new Set([
  'appium_find_element',
  'appium_find_elements',
  'appium_get_page_source',
  'appium_get_text',
  'appium_get_attribute',
  'appium_get_active_element',
  'appium_clear_element',
  'appium_scroll_to_element',
]);
