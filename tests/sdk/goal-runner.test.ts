import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { MCPClient, MCPToolInfo } from '../../src/mcp/types.js';
import type { AgentResult } from '../../src/agent/loop.js';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../src/llm/provider.js', () => ({
  createLLMProvider: vi.fn(),
}));

vi.mock('../../src/agent/loop.js', () => ({
  runAgent: vi.fn(),
}));

const { createLLMProvider } = await import('../../src/llm/provider.js');
const { runAgent } = await import('../../src/agent/loop.js');
const { GoalRunner } = await import('../../src/sdk/goal-runner.js');

// ── Helpers ───────────────────────────────────────────────────────────────

const mockMcp: MCPClient = {
  callTool: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn(),
};

const mockTools: MCPToolInfo[] = [{ name: 'appium_click' }, { name: 'appium_type' }];

const mockLLM = {
  supportsVision: false,
  getDecision: vi.fn(),
  feedToolResult: vi.fn(),
  resetHistory: vi.fn(),
};

function agentSuccess(stepsUsed = 3): AgentResult {
  return { success: true, reason: 'Goal completed', stepsUsed, history: [] };
}

function agentFailure(reason: string): AgentResult {
  return { success: false, reason, stepsUsed: 5, history: [] };
}

function makeConfig(overrides = {}) {
  return {
    MAX_STEPS: 30,
    STEP_DELAY: 500,
    VISION_MODE: 'fallback' as const,
    LLM_PROVIDER: 'anthropic',
    LLM_API_KEY: 'sk-test',
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createLLMProvider).mockReturnValue(mockLLM as any);
  vi.mocked(runAgent).mockResolvedValue(agentSuccess());
});

// ── LLM provider creation ─────────────────────────────────────────────────

describe('GoalRunner — LLM provider creation', () => {
  test('creates an LLM provider via createLLMProvider', async () => {
    const config = makeConfig();
    const runner = new GoalRunner(mockMcp, mockTools, config);
    await runner.run('Log in to the app');
    expect(createLLMProvider).toHaveBeenCalledOnce();
  });

  test('passes config to createLLMProvider', async () => {
    const config = makeConfig({ LLM_PROVIDER: 'openai' });
    const runner = new GoalRunner(mockMcp, mockTools, config);
    await runner.run('Open settings');
    expect(createLLMProvider).toHaveBeenCalledWith(config, mockTools);
  });

  test('passes the tool list to createLLMProvider', async () => {
    const config = makeConfig();
    const runner = new GoalRunner(mockMcp, mockTools, config);
    await runner.run('Tap login');
    expect(createLLMProvider).toHaveBeenCalledWith(config, mockTools);
  });

  test('creates a fresh LLM provider on each run() call', async () => {
    const config = makeConfig();
    const runner = new GoalRunner(mockMcp, mockTools, config);
    await runner.run('Goal one');
    await runner.run('Goal two');
    expect(createLLMProvider).toHaveBeenCalledTimes(2);
  });
});

// ── Agent invocation ──────────────────────────────────────────────────────

describe('GoalRunner — runAgent invocation', () => {
  test('calls runAgent with goal, mcp, and llm', async () => {
    const config = makeConfig();
    const runner = new GoalRunner(mockMcp, mockTools, config);
    await runner.run('Complete checkout');

    expect(runAgent).toHaveBeenCalledOnce();
    const call = vi.mocked(runAgent).mock.calls[0][0];
    expect(call.goal).toBe('Complete checkout');
    expect(call.mcp).toBe(mockMcp);
    expect(call.llm).toBe(mockLLM);
  });

  test('passes maxSteps from config', async () => {
    const config = makeConfig({ MAX_STEPS: 10 });
    const runner = new GoalRunner(mockMcp, mockTools, config);
    await runner.run('Some goal');

    const call = vi.mocked(runAgent).mock.calls[0][0];
    expect(call.maxSteps).toBe(10);
  });

  test('passes stepDelay from config', async () => {
    const config = makeConfig({ STEP_DELAY: 200 });
    const runner = new GoalRunner(mockMcp, mockTools, config);
    await runner.run('Some goal');

    const call = vi.mocked(runAgent).mock.calls[0][0];
    expect(call.stepDelay).toBe(200);
  });

  test('passes visionMode from config', async () => {
    const config = makeConfig({ VISION_MODE: 'never' });
    const runner = new GoalRunner(mockMcp, mockTools, config);
    await runner.run('Some goal');

    const call = vi.mocked(runAgent).mock.calls[0][0];
    expect(call.visionMode).toBe('never');
  });
});

// ── Result passthrough ────────────────────────────────────────────────────

describe('GoalRunner — result passthrough', () => {
  test('returns the AgentResult directly on success', async () => {
    vi.mocked(runAgent).mockResolvedValue(agentSuccess(4));
    const runner = new GoalRunner(mockMcp, mockTools, makeConfig());
    const result = await runner.run('Do something');

    expect(result.success).toBe(true);
    expect(result.stepsUsed).toBe(4);
    expect(result.reason).toBe('Goal completed');
  });

  test('returns the AgentResult directly on failure', async () => {
    vi.mocked(runAgent).mockResolvedValue(agentFailure('Max steps exceeded'));
    const runner = new GoalRunner(mockMcp, mockTools, makeConfig());
    const result = await runner.run('Do something');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('Max steps exceeded');
  });

  test('propagates runAgent errors', async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error('MCP disconnected'));
    const runner = new GoalRunner(mockMcp, mockTools, makeConfig());
    await expect(runner.run('Some goal')).rejects.toThrow('MCP disconnected');
  });
});

// ── History isolation ─────────────────────────────────────────────────────

describe('GoalRunner — history isolation', () => {
  test('each run gets a fresh LLM provider so history does not bleed', async () => {
    // Two distinct LLM mock instances
    const llm1 = { ...mockLLM };
    const llm2 = { ...mockLLM };
    vi.mocked(createLLMProvider)
      .mockReturnValueOnce(llm1 as any)
      .mockReturnValueOnce(llm2 as any);

    const runner = new GoalRunner(mockMcp, mockTools, makeConfig());
    await runner.run('Goal one');
    await runner.run('Goal two');

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls[0][0].llm).toBe(llm1);
    expect(calls[1][0].llm).toBe(llm2);
    expect(calls[0][0].llm).not.toBe(calls[1][0].llm);
  });
});
