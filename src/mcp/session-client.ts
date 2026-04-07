/**
 * Session-scoped MCP client wrapper.
 *
 * Wraps any MCPClient and automatically injects `sessionId` into every
 * tool call that is session-scoped. This lets multiple parallel workers
 * share a single appium-mcp process (one OS subprocess) while each worker
 * operates on its own Appium session, fully isolated.
 *
 * Because each SessionScopedMCPClient is a distinct object, WeakMap-based
 * caches (e.g. window-size.ts) automatically partition state per worker.
 */

import type { MCPClient, MCPToolResult, MCPToolInfo } from './types.js';

/**
 * Tools that operate before or outside a specific session.
 * These must NOT receive a sessionId injection.
 */
const PRE_SESSION_TOOLS = new Set([
  'create_session',
  'select_platform',
  'select_device',
  'delete_all_sessions',
  'list_sessions',
]);

export class SessionScopedMCPClient implements MCPClient {
  readonly sessionId: string;
  private readonly base: MCPClient;

  constructor(base: MCPClient, sessionId: string) {
    this.base = base;
    this.sessionId = sessionId;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const injected = PRE_SESSION_TOOLS.has(name) ? args : { sessionId: this.sessionId, ...args };
    return this.base.callTool(name, injected);
  }

  async listTools(): Promise<MCPToolInfo[]> {
    return this.base.listTools();
  }

  /**
   * No-op: the underlying shared client is managed by the parallel runner.
   * Workers must not close the shared connection themselves.
   */
  async close(): Promise<void> {}
}
