import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { MCPClient, MCPToolInfo, SharedMCPClient } from '../../src/mcp/types.js';

// ── Mock acquireSharedMCPClient ───────────────────────────────────────────

const mockRelease = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue([
  { name: 'appium_click', description: 'Click an element' },
  { name: 'appium_type', description: 'Type text' },
] as MCPToolInfo[]);
const mockCallTool = vi.fn().mockResolvedValue({ content: [] });
const mockClose = vi.fn().mockResolvedValue(undefined);

function makeSharedClient(): SharedMCPClient {
  return {
    callTool: mockCallTool,
    listTools: mockListTools,
    close: mockClose,
    release: mockRelease,
  };
}

vi.mock('../../src/mcp/client.js', () => ({
  acquireSharedMCPClient: vi.fn(),
}));

vi.mock('../../src/device/session.js', () => ({
  createPlatformSession: vi.fn(),
}));

const { acquireSharedMCPClient } = await import('../../src/mcp/client.js');
const { createPlatformSession } = await import('../../src/device/session.js');
const { McpSession } = await import('../../src/sdk/mcp-session.js');

function makeConfig(overrides = {}) {
  return {
    MCP_TRANSPORT: 'stdio' as const,
    MCP_HOST: 'localhost',
    MCP_PORT: 8080,
    ...overrides,
  } as any;
}

const mockScopedMcp: MCPClient = {
  callTool: vi.fn().mockResolvedValue({ content: [] }),
  listTools: vi.fn().mockResolvedValue([]),
  close: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireSharedMCPClient).mockResolvedValue(makeSharedClient());
  vi.mocked(createPlatformSession).mockResolvedValue({
    platform: 'android',
    sessionText: 'mock session',
    sessionId: 'mock-session-id',
    scopedMcp: mockScopedMcp,
  } as any);
});

// ── Lazy connection ───────────────────────────────────────────────────────

describe('McpSession — lazy connection', () => {
  test('does not connect on construction', () => {
    new McpSession(makeConfig());
    expect(acquireSharedMCPClient).not.toHaveBeenCalled();
  });

  test('connects on first connect() call', async () => {
    const session = new McpSession(makeConfig());
    await session.connect();
    expect(acquireSharedMCPClient).toHaveBeenCalledOnce();
  });

  test('passes correct MCPConfig to acquireSharedMCPClient', async () => {
    const session = new McpSession(
      makeConfig({
        MCP_TRANSPORT: 'sse',
        MCP_HOST: '10.0.0.1',
        MCP_PORT: 9090,
      })
    );
    await session.connect();
    expect(acquireSharedMCPClient).toHaveBeenCalledWith({
      transport: 'sse',
      host: '10.0.0.1',
      port: 9090,
    });
  });
});

// ── Connection reuse ──────────────────────────────────────────────────────

describe('McpSession — connection reuse', () => {
  test('reuses the same connection on multiple connect() calls', async () => {
    const session = new McpSession(makeConfig());
    await session.connect();
    await session.connect();
    await session.connect();
    expect(acquireSharedMCPClient).toHaveBeenCalledOnce();
  });

  test('returns the same client instance on every call', async () => {
    const session = new McpSession(makeConfig());
    const first = await session.connect();
    const second = await session.connect();
    expect(first.client).toBe(second.client);
  });

  test('caches the tool list after the first connect', async () => {
    const session = new McpSession(makeConfig());
    await session.connect();
    await session.connect();
    // listTools is called once during the first connect, not again
    expect(mockListTools).toHaveBeenCalledOnce();
  });
});

// ── Tool list ─────────────────────────────────────────────────────────────

describe('McpSession — tool list', () => {
  test('returns the tool list from the MCP client', async () => {
    const session = new McpSession(makeConfig());
    const { tools } = await session.connect();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('appium_click');
    expect(tools[1].name).toBe('appium_type');
  });
});

// ── Release ───────────────────────────────────────────────────────────────

describe('McpSession — release', () => {
  test('calls release() on the shared client handle', async () => {
    const session = new McpSession(makeConfig());
    await session.connect();
    await session.release();
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  test('release without prior connect is a no-op', async () => {
    const session = new McpSession(makeConfig());
    await expect(session.release()).resolves.not.toThrow();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('reconnects after release', async () => {
    const session = new McpSession(makeConfig());
    await session.connect();
    await session.release();
    await session.connect();
    expect(acquireSharedMCPClient).toHaveBeenCalledTimes(2);
  });

  test('double release is a no-op on the second call', async () => {
    const session = new McpSession(makeConfig());
    await session.connect();
    await session.release();
    await session.release();
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  test('clears cached tools after release', async () => {
    const session = new McpSession(makeConfig());
    const before = await session.connect();
    await session.release();

    // New tools returned after reconnect
    const newTools: MCPToolInfo[] = [{ name: 'appium_screenshot' }];
    mockListTools.mockResolvedValueOnce(newTools);
    const after = await session.connect();

    expect(after.tools).toHaveLength(1);
    expect(after.tools[0].name).toBe('appium_screenshot');
  });
});

// ── Isolation ─────────────────────────────────────────────────────────────

describe('McpSession — isolation', () => {
  test('two sessions connect independently', async () => {
    const session1 = new McpSession(makeConfig());
    const session2 = new McpSession(makeConfig());

    await session1.connect();
    await session2.connect();

    expect(acquireSharedMCPClient).toHaveBeenCalledTimes(2);
  });

  test('releasing one session does not affect the other', async () => {
    const session1 = new McpSession(makeConfig());
    const session2 = new McpSession(makeConfig());

    await session1.connect();
    await session2.connect();
    await session1.release();

    // session2 should still have its handle
    const { client } = await session2.connect();
    expect(client).toBeDefined();
    expect(acquireSharedMCPClient).toHaveBeenCalledTimes(2); // no new connection
  });
});
