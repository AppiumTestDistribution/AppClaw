/**
 * MCP session manager.
 *
 * Single Responsibility: own the lifecycle of the MCP client connection.
 * Lazily connects on first use, reuses across multiple run calls,
 * and releases cleanly on teardown.
 *
 * Depends on the MCPClient and SharedMCPClient interfaces (not concretions),
 * satisfying the Dependency Inversion Principle.
 */

import { acquireSharedMCPClient } from '../mcp/client.js';
import { createPlatformSession } from '../device/session.js';
import type { MCPClient, MCPToolInfo, SharedMCPClient } from '../mcp/types.js';
import type { AppClawConfig } from '../config.js';
import type { Platform } from '../index.js';

export interface ConnectedSession {
  client: MCPClient;
  tools: MCPToolInfo[];
}

export class McpSession {
  private readonly config: AppClawConfig;
  private handle: SharedMCPClient | null = null;
  private scopedClient: MCPClient | null = null;
  private cachedTools: MCPToolInfo[] = [];

  constructor(config: AppClawConfig) {
    this.config = config;
  }

  /**
   * Return the active MCP client and its tool list.
   * Connects on first call; subsequent calls reuse the existing connection.
   */
  async connect(): Promise<ConnectedSession> {
    if (!this.handle) {
      this.handle = await acquireSharedMCPClient({
        transport: this.config.MCP_TRANSPORT,
        host: this.config.MCP_HOST,
        port: this.config.MCP_PORT,
      });
      const platform = (this.config.PLATFORM || 'android') as Platform;
      const { scopedMcp } = await createPlatformSession(this.handle, this.config, platform);
      this.scopedClient = scopedMcp;
      this.cachedTools = await this.handle.listTools();
    }
    return { client: this.scopedClient!, tools: this.cachedTools };
  }

  /**
   * Release the MCP connection.
   * The underlying appium-mcp process is closed when the last handle is released.
   */
  async release(): Promise<void> {
    if (this.handle) {
      await this.handle.release();
      this.handle = null;
      this.scopedClient = null;
      this.cachedTools = [];
    }
  }
}
