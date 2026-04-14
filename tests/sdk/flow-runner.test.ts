import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { MCPClient } from '../../src/mcp/types.js';
import type { ParsedFlow } from '../../src/flow/types.js';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../src/flow/parse-yaml-flow.js', () => ({
  parseFlowYamlFile: vi.fn(),
}));

vi.mock('../../src/flow/run-yaml-flow.js', () => ({
  runYamlFlow: vi.fn(),
}));

const { parseFlowYamlFile } = await import('../../src/flow/parse-yaml-flow.js');
const { runYamlFlow } = await import('../../src/flow/run-yaml-flow.js');
const { FlowRunner } = await import('../../src/sdk/flow-runner.js');

// ── Helpers ───────────────────────────────────────────────────────────────

const mockMcp: MCPClient = {
  callTool: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn(),
};

function parsedFlow(overrides: Partial<ParsedFlow> = {}): ParsedFlow {
  return {
    meta: { name: 'Test Flow', platform: 'android' },
    steps: [{ kind: 'tap', label: 'Login' }, { kind: 'done' }],
    phases: [],
    ...overrides,
  };
}

function flowSuccess(stepsExecuted = 2, stepsTotal = 2) {
  return {
    success: true,
    stepsExecuted,
    stepsTotal,
    reason: undefined,
    failedAt: undefined,
    failedPhase: undefined,
    phaseResults: [],
  };
}

function flowFailure(reason: string, failedAt = 1, failedPhase = 'test') {
  return {
    success: false,
    stepsExecuted: 1,
    stepsTotal: 2,
    reason,
    failedAt,
    failedPhase,
    phaseResults: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseFlowYamlFile).mockResolvedValue(parsedFlow());
  vi.mocked(runYamlFlow).mockResolvedValue(flowSuccess());
});

// ── Basic execution ───────────────────────────────────────────────────────

describe('FlowRunner — basic execution', () => {
  test('calls parseFlowYamlFile with the given path', async () => {
    const runner = new FlowRunner(mockMcp);
    await runner.run('./flows/checkout.yaml');
    expect(parseFlowYamlFile).toHaveBeenCalledWith('./flows/checkout.yaml');
  });

  test('calls runYamlFlow with mcp, meta, steps, options, phases', async () => {
    const flow = parsedFlow();
    vi.mocked(parseFlowYamlFile).mockResolvedValue(flow);

    const runner = new FlowRunner(mockMcp);
    await runner.run('./flows/checkout.yaml');

    expect(runYamlFlow).toHaveBeenCalledWith(
      mockMcp,
      flow.meta,
      flow.steps,
      {}, // default empty options
      flow.phases
    );
  });

  test('forwards options to runYamlFlow', async () => {
    const runner = new FlowRunner(mockMcp);
    const options = { stepDelayMs: 1000 };
    await runner.run('./flows/checkout.yaml', options);

    const call = vi.mocked(runYamlFlow).mock.calls[0];
    expect(call[3]).toEqual(options);
  });
});

// ── Result mapping ────────────────────────────────────────────────────────

describe('FlowRunner — result mapping', () => {
  test('maps success result correctly', async () => {
    vi.mocked(runYamlFlow).mockResolvedValue(flowSuccess(3, 5));
    const runner = new FlowRunner(mockMcp);
    const result = await runner.run('./flows/test.yaml');

    expect(result.success).toBe(true);
    expect(result.stepsUsed).toBe(3);
    expect(result.stepsTotal).toBe(5);
    expect(result.failedStep).toBeUndefined();
    expect(result.failedPhase).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  test('maps failure result correctly', async () => {
    vi.mocked(runYamlFlow).mockResolvedValue(flowFailure('Element not found', 2, 'test'));
    const runner = new FlowRunner(mockMcp);
    const result = await runner.run('./flows/test.yaml');

    expect(result.success).toBe(false);
    expect(result.stepsUsed).toBe(1);
    expect(result.stepsTotal).toBe(2);
    expect(result.failedStep).toBe(2);
    expect(result.failedPhase).toBe('test');
    expect(result.error).toBe('Element not found');
  });

  test('maps setup phase failure', async () => {
    vi.mocked(runYamlFlow).mockResolvedValue(flowFailure('App not found', 1, 'setup'));
    const runner = new FlowRunner(mockMcp);
    const result = await runner.run('./flows/test.yaml');

    expect(result.failedPhase).toBe('setup');
    expect(result.error).toBe('App not found');
  });
});

// ── Error propagation ─────────────────────────────────────────────────────

describe('FlowRunner — error propagation', () => {
  test('propagates parseFlowYamlFile errors', async () => {
    vi.mocked(parseFlowYamlFile).mockRejectedValue(new Error('File not found: missing.yaml'));
    const runner = new FlowRunner(mockMcp);
    await expect(runner.run('./missing.yaml')).rejects.toThrow('File not found: missing.yaml');
  });

  test('propagates runYamlFlow errors', async () => {
    vi.mocked(runYamlFlow).mockRejectedValue(new Error('MCP connection lost'));
    const runner = new FlowRunner(mockMcp);
    await expect(runner.run('./flows/test.yaml')).rejects.toThrow('MCP connection lost');
  });
});

// ── Multiple flows ────────────────────────────────────────────────────────

describe('FlowRunner — multiple flows', () => {
  test('can run multiple different flows sequentially', async () => {
    const runner = new FlowRunner(mockMcp);
    await runner.run('./flows/login.yaml');
    await runner.run('./flows/checkout.yaml');

    expect(parseFlowYamlFile).toHaveBeenCalledTimes(2);
    expect(parseFlowYamlFile).toHaveBeenNthCalledWith(1, './flows/login.yaml');
    expect(parseFlowYamlFile).toHaveBeenNthCalledWith(2, './flows/checkout.yaml');
  });
});
