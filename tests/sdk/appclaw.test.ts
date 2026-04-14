import { describe, test, expect, vi, beforeEach } from 'vitest';

// ── Mocks — set up before any module under test is imported ──────────────

vi.mock('../../src/mcp/client.js', () => ({
  acquireSharedMCPClient: vi.fn(),
}));

vi.mock('../../src/flow/parse-yaml-flow.js', () => ({
  parseFlowYamlFile: vi.fn(),
}));

vi.mock('../../src/flow/run-yaml-flow.js', () => ({
  runYamlFlow: vi.fn(),
}));

vi.mock('../../src/llm/provider.js', () => ({
  createLLMProvider: vi.fn(),
}));

vi.mock('../../src/agent/loop.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../../src/ui/terminal.js', () => ({
  silenceTerminalUI: vi.fn(),
  theme: { dim: (s: string) => s, info: (s: string) => s },
}));

vi.mock('../../src/device/session.js', () => ({
  createPlatformSession: vi.fn(),
}));

const { acquireSharedMCPClient } = await import('../../src/mcp/client.js');
const { createPlatformSession } = await import('../../src/device/session.js');
const { parseFlowYamlFile } = await import('../../src/flow/parse-yaml-flow.js');
const { runYamlFlow } = await import('../../src/flow/run-yaml-flow.js');
const { createLLMProvider } = await import('../../src/llm/provider.js');
const { runAgent } = await import('../../src/agent/loop.js');
const { silenceTerminalUI } = await import('../../src/ui/terminal.js');
const { AppClaw } = await import('../../src/sdk/index.js');

// ── Shared fixture builders ───────────────────────────────────────────────

const mockRelease = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue([{ name: 'appium_click' }]);
const mockCallTool = vi.fn().mockResolvedValue({ content: [] });
const mockClose = vi.fn().mockResolvedValue(undefined);

function makeSharedClient() {
  return {
    callTool: mockCallTool,
    listTools: mockListTools,
    close: mockClose,
    release: mockRelease,
  };
}

const stubParsedFlow = {
  meta: { name: 'Stub Flow' },
  steps: [{ kind: 'done' as const }],
  phases: [],
};

const stubFlowResult = {
  success: true,
  stepsExecuted: 1,
  stepsTotal: 1,
  reason: undefined,
  failedAt: undefined,
  failedPhase: undefined,
  phaseResults: [],
};

const stubAgentResult = {
  success: true,
  reason: 'Done',
  stepsUsed: 2,
  history: [],
};

const mockLLM = {
  supportsVision: false,
  getDecision: vi.fn(),
  feedToolResult: vi.fn(),
  resetHistory: vi.fn(),
};

const stubScopedMcp = {
  callTool: vi.fn().mockResolvedValue({ content: [] }),
  listTools: vi.fn().mockResolvedValue([]),
  close: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireSharedMCPClient).mockResolvedValue(makeSharedClient() as any);
  vi.mocked(createPlatformSession).mockResolvedValue({
    platform: 'android',
    sessionText: 'mock session',
    sessionId: 'mock-session-id',
    scopedMcp: stubScopedMcp,
  } as any);
  vi.mocked(parseFlowYamlFile).mockResolvedValue(stubParsedFlow as any);
  vi.mocked(runYamlFlow).mockResolvedValue(stubFlowResult as any);
  vi.mocked(createLLMProvider).mockReturnValue(mockLLM as any);
  vi.mocked(runAgent).mockResolvedValue(stubAgentResult as any);
});

// ── Constructor ───────────────────────────────────────────────────────────

describe('AppClaw — constructor', () => {
  test('constructs without errors with empty options', () => {
    expect(() => new AppClaw()).not.toThrow();
  });

  test('constructs without errors with all options', () => {
    expect(
      () =>
        new AppClaw({
          provider: 'anthropic',
          apiKey: 'sk-test',
          model: 'claude-opus-4-6',
          platform: 'android',
          agentMode: 'dom',
          maxSteps: 20,
          stepDelay: 300,
          silent: true,
          mcpTransport: 'stdio',
          mcpHost: 'localhost',
          mcpPort: 8080,
        })
    ).not.toThrow();
  });

  test('calls silenceTerminalUI when silent is not explicitly false', () => {
    new AppClaw({ silent: true });
    expect(silenceTerminalUI).toHaveBeenCalledOnce();
  });

  test('calls silenceTerminalUI when silent is omitted (default)', () => {
    new AppClaw({});
    expect(silenceTerminalUI).toHaveBeenCalledOnce();
  });

  test('does NOT call silenceTerminalUI when silent is false', () => {
    new AppClaw({ silent: false });
    expect(silenceTerminalUI).not.toHaveBeenCalled();
  });

  test('does not connect to MCP on construction', () => {
    new AppClaw({ provider: 'anthropic' });
    expect(acquireSharedMCPClient).not.toHaveBeenCalled();
  });
});

// ── runFlow ───────────────────────────────────────────────────────────────

describe('AppClaw — runFlow', () => {
  test('connects to MCP on first runFlow call', async () => {
    const app = new AppClaw();
    await app.runFlow('./flows/test.yaml');
    expect(acquireSharedMCPClient).toHaveBeenCalledOnce();
    await app.teardown();
  });

  test('reuses MCP connection on subsequent runFlow calls', async () => {
    const app = new AppClaw();
    await app.runFlow('./flows/a.yaml');
    await app.runFlow('./flows/b.yaml');
    expect(acquireSharedMCPClient).toHaveBeenCalledOnce();
    await app.teardown();
  });

  test('returns FlowResult with success=true on success', async () => {
    const app = new AppClaw();
    const result = await app.runFlow('./flows/test.yaml');
    expect(result.success).toBe(true);
    await app.teardown();
  });

  test('returns FlowResult with success=false on failure', async () => {
    vi.mocked(runYamlFlow).mockResolvedValue({
      ...stubFlowResult,
      success: false,
      reason: 'Step failed',
      failedAt: 1,
    } as any);
    const app = new AppClaw();
    const result = await app.runFlow('./flows/test.yaml');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Step failed');
    await app.teardown();
  });

  test('passes flow path to parseFlowYamlFile', async () => {
    const app = new AppClaw();
    await app.runFlow('./flows/checkout.yaml');
    expect(parseFlowYamlFile).toHaveBeenCalledWith('./flows/checkout.yaml');
    await app.teardown();
  });

  test('forwards RunYamlFlowOptions to the flow engine', async () => {
    const app = new AppClaw();
    const options = { stepDelayMs: 800 };
    await app.runFlow('./flows/test.yaml', options);

    const call = vi.mocked(runYamlFlow).mock.calls[0];
    expect(call[3]).toEqual(options);
    await app.teardown();
  });
});

// ── runGoal ───────────────────────────────────────────────────────────────

describe('AppClaw — runGoal', () => {
  test('connects to MCP on first runGoal call', async () => {
    const app = new AppClaw();
    await app.runGoal('Log in');
    expect(acquireSharedMCPClient).toHaveBeenCalledOnce();
    await app.teardown();
  });

  test('reuses MCP connection across runGoal calls', async () => {
    const app = new AppClaw();
    await app.runGoal('Log in');
    await app.runGoal('Check order status');
    expect(acquireSharedMCPClient).toHaveBeenCalledOnce();
    await app.teardown();
  });

  test('passes goal string to runAgent', async () => {
    const app = new AppClaw();
    await app.runGoal('Complete checkout');
    const call = vi.mocked(runAgent).mock.calls[0][0];
    expect(call.goal).toBe('Complete checkout');
    await app.teardown();
  });

  test('creates a fresh LLM provider for each runGoal call', async () => {
    const app = new AppClaw();
    await app.runGoal('Goal one');
    await app.runGoal('Goal two');
    expect(createLLMProvider).toHaveBeenCalledTimes(2);
    await app.teardown();
  });

  test('returns AgentResult directly', async () => {
    const app = new AppClaw();
    const result = await app.runGoal('Log in');
    expect(result.success).toBe(true);
    expect(result.reason).toBe('Done');
    await app.teardown();
  });
});

// ── Mixed flow and goal ───────────────────────────────────────────────────

describe('AppClaw — mixed runFlow and runGoal', () => {
  test('shares MCP connection between runFlow and runGoal', async () => {
    const app = new AppClaw();
    await app.runFlow('./flows/setup.yaml');
    await app.runGoal('Check the result');
    expect(acquireSharedMCPClient).toHaveBeenCalledOnce();
    await app.teardown();
  });
});

// ── teardown ──────────────────────────────────────────────────────────────

describe('AppClaw — teardown', () => {
  test('is safe to call without a prior connect', async () => {
    const app = new AppClaw();
    await expect(app.teardown()).resolves.not.toThrow();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('releases the MCP handle after connect', async () => {
    const app = new AppClaw();
    await app.runFlow('./flows/test.yaml');
    await app.teardown();
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  test('double teardown does not throw', async () => {
    const app = new AppClaw();
    await app.runFlow('./flows/test.yaml');
    await app.teardown();
    await expect(app.teardown()).resolves.not.toThrow();
    expect(mockRelease).toHaveBeenCalledOnce(); // not twice
  });
});

// ── Instance isolation ────────────────────────────────────────────────────

describe('AppClaw — instance isolation', () => {
  test('two instances have independent MCP connections', async () => {
    const app1 = new AppClaw({ provider: 'anthropic' });
    const app2 = new AppClaw({ provider: 'openai' });

    await app1.runFlow('./flows/test.yaml');
    await app2.runFlow('./flows/test.yaml');

    expect(acquireSharedMCPClient).toHaveBeenCalledTimes(2);

    await app1.teardown();
    await app2.teardown();
  });

  test('tearing down one instance does not affect the other', async () => {
    const app1 = new AppClaw();
    const app2 = new AppClaw();

    await app1.runFlow('./flows/test.yaml');
    await app2.runFlow('./flows/test.yaml');
    await app1.teardown();

    // app2 should still be able to run
    await app2.runFlow('./flows/another.yaml');
    expect(acquireSharedMCPClient).toHaveBeenCalledTimes(2); // no new connection for app2

    await app2.teardown();
  });
});
