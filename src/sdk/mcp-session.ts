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

import * as net from 'net';
import { acquireSharedMCPClient } from '../mcp/client.js';
import { createPlatformSession } from '../device/session.js';
import type { MCPClient, MCPToolInfo, SharedMCPClient } from '../mcp/types.js';
import type { AppClawConfig } from '../config.js';
import type { Platform } from '../index.js';
import { AppResolver } from '../agent/app-resolver.js';

/** Bind to port 0 to let the OS assign a free ephemeral port, then release it. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

/** Allocate platform-specific unique ports so parallel SDK instances don't collide. */
async function buildParallelCaps(platform: Platform): Promise<Record<string, unknown>> {
  if (platform === 'android') {
    const [systemPort, mjpegPort] = await Promise.all([findFreePort(), findFreePort()]);
    return {
      'appium:systemPort': systemPort,
      'appium:mjpegServerPort': mjpegPort,
      'appium:mjpegScreenshotUrl': `http://127.0.0.1:${mjpegPort}`,
    };
  }
  if (platform === 'ios') {
    const wdaPort = await findFreePort();
    return { 'appium:wdaLocalPort': wdaPort };
  }
  return {};
}

export interface ConnectedSession {
  client: MCPClient;
  tools: MCPToolInfo[];
  appResolver: AppResolver;
}

export class McpSession {
  private readonly config: AppClawConfig;
  private handle: SharedMCPClient | null = null;
  private scopedClient: MCPClient | null = null;
  private cachedTools: MCPToolInfo[] = [];
  private cachedAppResolver: AppResolver | null = null;

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
      // Allocate unique ports per instance so parallel tests don't collide on
      // mjpegServerPort / systemPort (mirrors what the parallel runner does).
      const extraCaps = await buildParallelCaps(platform);
      // Pin to a specific device when DEVICE_UDID is set — required for parallel runs
      // so concurrent instances don't race on appium-mcp's shared activeDevice global.
      const udid = this.config.DEVICE_UDID?.trim();
      if (udid) extraCaps['appium:udid'] = udid;
      const { scopedMcp } = await createPlatformSession(
        this.handle,
        this.config,
        platform,
        undefined,
        extraCaps
      );
      this.scopedClient = scopedMcp;
      this.cachedTools = await this.handle.listTools();
      const appResolver = new AppResolver();
      await appResolver.initialize(this.scopedClient, platform);
      this.cachedAppResolver = appResolver;
    }
    return {
      client: this.scopedClient!,
      tools: this.cachedTools,
      appResolver: this.cachedAppResolver!,
    };
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
      this.cachedAppResolver = null;
    }
  }
}
