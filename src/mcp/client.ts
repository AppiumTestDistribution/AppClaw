import { createRequire } from 'module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { MCPClient, MCPConfig, MCPToolResult, MCPToolInfo } from './types.js';
import { theme } from '../ui/terminal.js';
import { VERSION } from '../version.js';

/**
 * Resolve the appium-mcp binary.
 *
 * Prefer the locally-installed package (bundled as a dependency) so the
 * MCP server starts immediately — no npm download at connect time.
 * The MCP SDK's initialize handshake has a hardcoded 60 s timeout that
 * fires before npx can download a missing package in slow CI environments.
 *
 * Falls back to npx for backwards compatibility (e.g. very old global installs
 * that pre-date appium-mcp being a listed dependency).
 */
function resolveAppiumMcp(): { command: string; args: string[] } {
  try {
    const req = createRequire(import.meta.url);
    const bin = req.resolve('appium-mcp');
    return { command: 'node', args: [bin] };
  } catch {
    return { command: 'npx', args: ['--yes', 'appium-mcp@1.67.0'] };
  }
}

const appiumMcp = resolveAppiumMcp();

/** Tools that produce verbose output we don't want to log */
const QUIET_TOOLS = new Set(['appium_get_page_source', 'appium_screenshot', 'appium_list_apps']);

const mcpDebug = process.env.MCP_DEBUG === '1' || process.env.MCP_DEBUG === 'true';

/** Request timeout in ms — default 120 s, override via MCP_TIMEOUT_MS env var */
const MCP_TIMEOUT_MS = process.env.MCP_TIMEOUT_MS
  ? parseInt(process.env.MCP_TIMEOUT_MS, 10)
  : 120000;

function logMCP(name: string, args: Record<string, unknown>, result: MCPToolResult): void {
  if (!mcpDebug) return;
  if (QUIET_TOOLS.has(name)) return;

  // Format args compactly
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : v}`)
    .join(' ');

  // Extract response text
  const resText =
    result.content
      ?.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join(' ')
      .slice(0, 200) ?? '';

  console.log(`        ${theme.dim('mcp')} ${theme.info(name)} ${theme.dim(argStr)}`);
  if (resText) {
    console.log(`        ${theme.dim('  ⤷')} ${theme.dim(resText)}`);
  }
}

/** Build the underlying MCP Client + connect transport */
async function connectClient(config: MCPConfig): Promise<Client> {
  const client = new Client({ name: 'appclaw', version: VERSION });

  if (config.transport === 'stdio') {
    // Detect Android SDK path for appium-mcp subprocess
    const androidHome =
      process.env.ANDROID_HOME ||
      process.env.ANDROID_SDK_ROOT ||
      `${process.env.HOME}/Library/Android/sdk`;

    const transport = new StdioClientTransport({
      command: appiumMcp.command,
      args: appiumMcp.args,
      env: {
        ...process.env,
        ANDROID_HOME: androidHome,
        ANDROID_SDK_ROOT: androidHome,
        PATH: `${androidHome}/platform-tools:${androidHome}/emulator:${process.env.PATH}`,
        // AI Vision env vars — explicitly forwarded to appium-mcp subprocess
        ...(process.env.AI_VISION_API_BASE_URL && {
          AI_VISION_API_BASE_URL: process.env.AI_VISION_API_BASE_URL,
        }),
        ...(process.env.AI_VISION_API_KEY && { AI_VISION_API_KEY: process.env.AI_VISION_API_KEY }),
        ...(process.env.AI_VISION_MODEL && { AI_VISION_MODEL: process.env.AI_VISION_MODEL }),
        ...(process.env.AI_VISION_COORD_TYPE && {
          AI_VISION_COORD_TYPE: process.env.AI_VISION_COORD_TYPE,
        }),
        ...(process.env.AI_VISION_IMAGE_MAX_WIDTH && {
          AI_VISION_IMAGE_MAX_WIDTH: process.env.AI_VISION_IMAGE_MAX_WIDTH,
        }),
        ...(process.env.AI_VISION_IMAGE_QUALITY && {
          AI_VISION_IMAGE_QUALITY: process.env.AI_VISION_IMAGE_QUALITY,
        }),
      },
      stderr: 'pipe',
    });

    // Buffer stderr — log live in debug mode, attach to error on failure so root cause is visible
    const stderrLines: string[] = [];
    if (transport.stderr) {
      transport.stderr.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (!msg) return;
        // Filter npm install noise so only real appium-mcp output remains
        if (!msg.startsWith('npm warn') && !msg.startsWith('npm notice')) {
          stderrLines.push(msg);
        }
        if (mcpDebug) {
          console.error(`  ${theme.dim('[appium-mcp]')} ${theme.dim(msg)}`);
        }
      });
    }

    try {
      await client.connect(transport);
    } catch (err: any) {
      if (stderrLines.length > 0) {
        const detail = stderrLines.join('\n');
        err.mcpStderr = detail;
        err.message = `${err.message}\n\nappium-mcp output:\n${detail}`;
      }
      throw err;
    }
  } else {
    const url = new URL(`http://${config.host}:${config.port}/sse`);
    const transport = new SSEClientTransport(url);
    await client.connect(transport);
  }

  return client;
}

/** Wrap a raw Client into our MCPClient interface */
function wrapClient(client: Client): MCPClient {
  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
      const t0 = mcpDebug ? performance.now() : 0;
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: MCP_TIMEOUT_MS,
      });
      const typed = result as MCPToolResult;
      if (mcpDebug) {
        const elapsed = Math.round(performance.now() - t0);
        console.log(`        ${theme.dim('mcp')} ${theme.info(name)} ${theme.dim(`${elapsed}ms`)}`);
      }
      logMCP(name, args, typed);
      return typed;
    },

    async listTools(): Promise<MCPToolInfo[]> {
      const { tools } = await client.listTools(undefined, { timeout: MCP_TIMEOUT_MS });
      return tools as MCPToolInfo[];
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

/** Create a standalone MCP client (one connection, one owner). */
export async function createMCPClient(config: MCPConfig): Promise<MCPClient> {
  const client = await connectClient(config);
  return wrapClient(client);
}

// ─── Shared MCP client with reference counting ───────────────────
// Allows multiple parallel flows to share one appium-mcp server.

/** Config key for deduplication */
function configKey(config: MCPConfig): string {
  return `${config.transport}:${config.host}:${config.port}`;
}

interface SharedEntry {
  client: Client;
  refCount: number;
  /** The promise used for initial connection (for dedup of concurrent acquires) */
  connectPromise: Promise<Client>;
}

const sharedClients = new Map<string, SharedEntry>();

/**
 * Acquire a shared MCP client. Multiple callers with the same config
 * will share a single underlying connection + appium-mcp process.
 *
 * Call `release()` on the returned handle when done. The underlying
 * connection is closed only when the last handle is released.
 */
export async function acquireSharedMCPClient(
  config: MCPConfig
): Promise<MCPClient & { release(): Promise<void> }> {
  const key = configKey(config);
  let entry = sharedClients.get(key);

  if (!entry) {
    // First caller — start connecting
    const connectPromise = connectClient(config);
    entry = {
      client: undefined as unknown as Client, // filled after await
      refCount: 0,
      connectPromise,
    };
    sharedClients.set(key, entry);
    entry.client = await connectPromise;
  } else {
    // Connection may still be in progress from a concurrent acquire
    await entry.connectPromise;
  }

  entry.refCount++;
  const wrapped = wrapClient(entry.client);

  return {
    callTool: wrapped.callTool,
    listTools: wrapped.listTools,
    // close() on shared clients is a no-op — use release() instead
    async close() {
      /* no-op for shared clients */
    },
    async release() {
      const e = sharedClients.get(key);
      if (!e) return;
      e.refCount--;
      if (e.refCount <= 0) {
        sharedClients.delete(key);
        await e.client.close();
      }
    },
  };
}
