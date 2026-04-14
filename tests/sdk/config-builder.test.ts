import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { buildConfig } from '../../src/sdk/config-builder.js';

// Snapshot of env vars we touch — restored after each test.
const TOUCHED_VARS = [
  'LLM_PROVIDER',
  'LLM_API_KEY',
  'LLM_MODEL',
  'PLATFORM',
  'AGENT_MODE',
  'MAX_STEPS',
  'STEP_DELAY',
  'MCP_TRANSPORT',
  'MCP_HOST',
  'MCP_PORT',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of TOUCHED_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

// ── Provider mapping ──────────────────────────────────────────────────────

describe('buildConfig — provider', () => {
  test('maps provider option to LLM_PROVIDER', () => {
    const config = buildConfig({ provider: 'anthropic' });
    expect(config.LLM_PROVIDER).toBe('anthropic');
  });

  test('supports all valid provider values', () => {
    const providers = ['anthropic', 'openai', 'gemini', 'groq', 'ollama'] as const;
    for (const p of providers) {
      const config = buildConfig({ provider: p });
      expect(config.LLM_PROVIDER).toBe(p);
    }
  });

  test('defaults to gemini when provider is not set', () => {
    const config = buildConfig({});
    expect(config.LLM_PROVIDER).toBe('gemini');
  });
});

// ── API key mapping ───────────────────────────────────────────────────────

describe('buildConfig — apiKey', () => {
  test('maps apiKey to LLM_API_KEY', () => {
    const config = buildConfig({ apiKey: 'sk-test-key' });
    expect(config.LLM_API_KEY).toBe('sk-test-key');
  });

  test('falls back to empty string when not set', () => {
    const config = buildConfig({});
    expect(config.LLM_API_KEY).toBe('');
  });

  test('option takes priority over process.env', () => {
    process.env.LLM_API_KEY = 'env-key';
    const config = buildConfig({ apiKey: 'option-key' });
    expect(config.LLM_API_KEY).toBe('option-key');
  });
});

// ── Model mapping ─────────────────────────────────────────────────────────

describe('buildConfig — model', () => {
  test('maps model to LLM_MODEL', () => {
    const config = buildConfig({ model: 'claude-opus-4-6' });
    expect(config.LLM_MODEL).toBe('claude-opus-4-6');
  });

  test('defaults to empty string when not set', () => {
    const config = buildConfig({});
    expect(config.LLM_MODEL).toBe('');
  });
});

// ── Platform mapping ──────────────────────────────────────────────────────

describe('buildConfig — platform', () => {
  test('maps platform android', () => {
    const config = buildConfig({ platform: 'android' });
    expect(config.PLATFORM).toBe('android');
  });

  test('maps platform ios', () => {
    const config = buildConfig({ platform: 'ios' });
    expect(config.PLATFORM).toBe('ios');
  });

  test('defaults to empty string when not set', () => {
    const config = buildConfig({});
    expect(config.PLATFORM).toBe('');
  });
});

// ── Agent mode mapping ────────────────────────────────────────────────────

describe('buildConfig — agentMode', () => {
  test('maps agentMode dom', () => {
    const config = buildConfig({ agentMode: 'dom' });
    expect(config.AGENT_MODE).toBe('dom');
  });

  test('maps agentMode vision', () => {
    const config = buildConfig({ agentMode: 'vision' });
    expect(config.AGENT_MODE).toBe('vision');
  });

  test('defaults to dom when not set', () => {
    const config = buildConfig({});
    expect(config.AGENT_MODE).toBe('dom');
  });
});

// ── Numeric option mapping ────────────────────────────────────────────────

describe('buildConfig — numeric options', () => {
  test('maps maxSteps to MAX_STEPS', () => {
    const config = buildConfig({ maxSteps: 15 });
    expect(config.MAX_STEPS).toBe(15);
  });

  test('maps stepDelay to STEP_DELAY', () => {
    const config = buildConfig({ stepDelay: 1000 });
    expect(config.STEP_DELAY).toBe(1000);
  });

  test('defaults MAX_STEPS to 30', () => {
    const config = buildConfig({});
    expect(config.MAX_STEPS).toBe(30);
  });

  test('defaults STEP_DELAY to 500', () => {
    const config = buildConfig({});
    expect(config.STEP_DELAY).toBe(500);
  });
});

// ── MCP transport mapping ─────────────────────────────────────────────────

describe('buildConfig — MCP options', () => {
  test('maps mcpTransport stdio', () => {
    const config = buildConfig({ mcpTransport: 'stdio' });
    expect(config.MCP_TRANSPORT).toBe('stdio');
  });

  test('maps mcpTransport sse', () => {
    const config = buildConfig({ mcpTransport: 'sse' });
    expect(config.MCP_TRANSPORT).toBe('sse');
  });

  test('maps mcpHost', () => {
    const config = buildConfig({ mcpHost: '192.168.1.1' });
    expect(config.MCP_HOST).toBe('192.168.1.1');
  });

  test('maps mcpPort', () => {
    const config = buildConfig({ mcpPort: 9090 });
    expect(config.MCP_PORT).toBe(9090);
  });

  test('defaults to stdio transport', () => {
    const config = buildConfig({});
    expect(config.MCP_TRANSPORT).toBe('stdio');
  });

  test('defaults to localhost', () => {
    const config = buildConfig({});
    expect(config.MCP_HOST).toBe('localhost');
  });

  test('defaults to port 8080', () => {
    const config = buildConfig({});
    expect(config.MCP_PORT).toBe(8080);
  });
});

// ── Priority: options override process.env ────────────────────────────────

describe('buildConfig — option priority', () => {
  test('option takes priority over process.env for provider', () => {
    process.env.LLM_PROVIDER = 'gemini';
    const config = buildConfig({ provider: 'openai' });
    expect(config.LLM_PROVIDER).toBe('openai');
  });

  test('option takes priority over process.env for maxSteps', () => {
    process.env.MAX_STEPS = '50';
    const config = buildConfig({ maxSteps: 5 });
    expect(config.MAX_STEPS).toBe(5);
  });

  test('falls back to process.env when option is omitted', () => {
    process.env.LLM_PROVIDER = 'groq';
    const config = buildConfig({});
    expect(config.LLM_PROVIDER).toBe('groq');
  });
});

// ── silent is SDK-only, not mapped to any env var ────────────────────────

describe('buildConfig — silent (SDK-only flag)', () => {
  test('silent option does not cause config errors', () => {
    expect(() => buildConfig({ silent: true })).not.toThrow();
    expect(() => buildConfig({ silent: false })).not.toThrow();
  });
});

// ── Empty options produces valid config with defaults ─────────────────────

describe('buildConfig — defaults', () => {
  test('empty options produces valid config', () => {
    const config = buildConfig({});
    expect(config).toMatchObject({
      LLM_PROVIDER: 'gemini',
      LLM_API_KEY: '',
      LLM_MODEL: '',
      PLATFORM: '',
      AGENT_MODE: 'dom',
      MAX_STEPS: 30,
      STEP_DELAY: 500,
      MCP_TRANSPORT: 'stdio',
      MCP_HOST: 'localhost',
      MCP_PORT: 8080,
    });
  });

  test('combined options all map correctly', () => {
    const config = buildConfig({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      model: 'claude-opus-4-6',
      platform: 'ios',
      agentMode: 'dom',
      maxSteps: 20,
      stepDelay: 200,
      mcpTransport: 'sse',
      mcpHost: '10.0.0.1',
      mcpPort: 3000,
    });

    expect(config.LLM_PROVIDER).toBe('anthropic');
    expect(config.LLM_API_KEY).toBe('sk-ant');
    expect(config.LLM_MODEL).toBe('claude-opus-4-6');
    expect(config.PLATFORM).toBe('ios');
    expect(config.AGENT_MODE).toBe('dom');
    expect(config.MAX_STEPS).toBe(20);
    expect(config.STEP_DELAY).toBe(200);
    expect(config.MCP_TRANSPORT).toBe('sse');
    expect(config.MCP_HOST).toBe('10.0.0.1');
    expect(config.MCP_PORT).toBe(3000);
  });
});
