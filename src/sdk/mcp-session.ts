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
import { allocatePort, releasePorts } from '../mcp/port-allocator.js';
import type { MCPClient, MCPToolInfo, SharedMCPClient } from '../mcp/types.js';
import type { AppClawConfig } from '../config.js';
import type { Platform } from '../index.js';
import { AppResolver } from '../agent/app-resolver.js';

/** Hosts that mean "the appium-mcp node shares this machine". */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

/**
 * Whether the appium-mcp node runs on this machine.
 *
 * Only a co-located node lets the control plane allocate driver ports locally
 * and pass them per session (`buildParallelCaps`). For a *remote* SSE node the
 * host owns its own ports — we can't probe them from here — so port allocation
 * must happen node-side: appium-mcp auto-fills `systemPort` / `wdaLocalPort` /
 * `mjpegServerPort` for embedded sessions when the caller omits them. See the
 * node-side port-allocation change in appium-mcp.
 *
 * Stdio always runs as a local subprocess. For SSE we go by host: anything that
 * isn't loopback is treated as remote.
 */
export function isLocalNode(config: AppClawConfig): boolean {
  if (config.MCP_TRANSPORT === 'stdio') return true;
  return LOCAL_HOSTS.has(config.MCP_HOST.trim().toLowerCase());
}

/**
 * Allocate platform-specific unique ports so parallel SDK instances don't
 * collide. Ports are reserved in the shared in-process allocator until session
 * creation settles (see `port-allocator.ts`); `ports` lists the reserved
 * numbers so the caller can release them afterward.
 */
async function buildParallelCaps(
  platform: Platform
): Promise<{ caps: Record<string, unknown>; ports: number[] }> {
  if (platform === 'android') {
    // Allocate sequentially (not Promise.all) so the reservation check is
    // strictly atomic per port — two parallel allocations can't collide.
    const systemPort = await allocatePort();
    const mjpegPort = await allocatePort();
    return {
      caps: {
        'appium:systemPort': systemPort,
        'appium:mjpegServerPort': mjpegPort,
        'appium:mjpegScreenshotUrl': `http://127.0.0.1:${mjpegPort}`,
      },
      ports: [systemPort, mjpegPort],
    };
  }
  if (platform === 'ios') {
    const wdaPort = await allocatePort();
    return { caps: { 'appium:wdaLocalPort': wdaPort }, ports: [wdaPort] };
  }
  return { caps: {}, ports: [] };
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
      // mjpegServerPort / systemPort / wdaLocalPort. Ports stay reserved in the
      // shared allocator until session creation settles, then are released.
      //
      // Local node only: a remote SSE node owns its own ports, so we omit them
      // and let appium-mcp allocate them node-side (auto-filled when unset).
      const { caps: extraCaps, ports } = isLocalNode(this.config)
        ? await buildParallelCaps(platform)
        : { caps: {} as Record<string, unknown>, ports: [] as number[] };
      // Pin to a specific device when DEVICE_UDID is set — required for parallel runs
      // so concurrent instances don't race on appium-mcp's shared activeDevice global.
      const udid = this.config.DEVICE_UDID?.trim();
      if (udid) extraCaps['appium:udid'] = udid;
      try {
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
      } finally {
        // Release the reservations: on success Appium has bound the ports (the
        // OS now prevents reuse); on failure they're free again. Either way the
        // creation window they guarded is over.
        releasePorts(ports);
      }
    }
    return {
      client: this.scopedClient!,
      tools: this.cachedTools,
      appResolver: this.cachedAppResolver!,
    };
  }

  /**
   * Release the MCP connection.
   *
   * Deletes the Appium session first so its driver runs cleanup — removing the
   * adb port forwards it opened for `systemPort`/`mjpegServerPort` and shutting
   * down the on-device server. Without this the session (and its forwards) leak:
   * the forwards live in the adb server, so they outlive even the appium-mcp
   * process and accumulate across runs until `adb kill-server`. `delete` is a
   * pre-session tool, so the sessionId is passed explicitly.
   *
   * The underlying appium-mcp connection is closed when the last handle is
   * released (ref-counted) — so on a shared SSE node this only tears down THIS
   * session, leaving sibling sessions untouched.
   */
  async release(): Promise<void> {
    if (this.handle) {
      const sessionId = this.scopedClient?.sessionId;
      if (sessionId) {
        try {
          await this.handle.callTool('appium_session_management', {
            action: 'delete',
            sessionId,
          });
        } catch {
          /* best-effort — a cleanup failure must never break teardown */
        }
      }
      await this.handle.release();
      this.handle = null;
      this.scopedClient = null;
      this.cachedTools = [];
      this.cachedAppResolver = null;
    }
  }
}
