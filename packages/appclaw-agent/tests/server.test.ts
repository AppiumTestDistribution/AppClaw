import { beforeEach, describe, expect, test, vi } from 'vitest';

const runtime = {
  sessionId: 'runtime-session',
  close: vi.fn().mockResolvedValue(undefined),
  snapshot: vi.fn(),
  press: vi.fn().mockResolvedValue({ success: true, message: 'pressed' }),
  fill: vi.fn().mockResolvedValue({ success: true, message: 'filled' }),
  longpress: vi.fn(),
  swipe: vi.fn(),
  pressKey: vi.fn(),
  getText: vi.fn(),
  getAttrs: vi.fn(),
  isVisible: vi.fn(),
  waitFor: vi.fn(),
  saveScreenshot: vi.fn(),
  visionPress: vi.fn(),
  visionVisible: vi.fn(),
  visionInfo: vi.fn(),
};

vi.mock('appclaw/agent-runtime', () => ({
  AgentRuntimeSession: {
    open: vi.fn().mockResolvedValue(runtime),
  },
}));

const { AgentDaemonState } = await import('../src/server.js');

beforeEach(() => {
  vi.clearAllMocks();
  runtime.snapshot.mockResolvedValue({
    platform: 'android',
    elements: [
      {
        type: 'Button',
        text: 'Login',
        id: 'login',
        accessibilityId: '',
        center: [10, 20],
        bounds: '[0,0][20,40]',
        action: 'tap',
        enabled: true,
        checked: false,
        focused: false,
        selector: { kind: 'id', value: 'login' },
      },
    ],
  });
});

describe('daemon session state', () => {
  test('retains named sessions and resolves a snapshot ref', async () => {
    const state = new AgentDaemonState();
    await state.execute('qa', {
      kind: 'open',
      options: { app: 'com.example', platform: 'android' },
    });
    const snapshot = await state.execute('qa', { kind: 'snapshot', interactiveOnly: true });
    expect(snapshot.output).toContain('@e1');

    await state.execute('qa', { kind: 'press', target: { ref: '@e1' } });
    expect(runtime.press).toHaveBeenCalledWith({ selector: { kind: 'id', value: 'login' } });
  });

  test('invalidates refs after a state-changing action', async () => {
    const state = new AgentDaemonState();
    await state.execute('qa', {
      kind: 'open',
      options: { app: 'com.example', platform: 'android' },
    });
    await state.execute('qa', { kind: 'snapshot', interactiveOnly: true });
    await state.execute('qa', { kind: 'press', target: { ref: '@e1' } });
    const stale = await state.execute('qa', { kind: 'press', target: { ref: '@e1' } });
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain('stale');
  });

  test('keeps named sessions isolated and closes one session', async () => {
    const state = new AgentDaemonState();
    await state.execute('one', {
      kind: 'open',
      options: { app: 'com.one', platform: 'android' },
    });
    await state.execute('two', {
      kind: 'open',
      options: { app: 'com.two', platform: 'android' },
    });
    await state.execute('one', { kind: 'close' });
    const listed = await state.execute('default', { kind: 'list' });
    expect(listed.data).toEqual({ sessions: ['two'] });
  });
});
