import { describe, expect, test, vi } from 'vitest';

vi.mock('appclaw/agent-runtime', () => ({
  AgentRuntimeSession: {
    open: vi.fn(),
  },
}));

const { AgentDaemon } = await import('../src/daemon.js');

describe('daemon authentication', () => {
  test('accepts its token and rejects a different token', async () => {
    const daemon = new AgentDaemon() as any;
    const accepted = { end: vi.fn() };
    const rejected = { end: vi.fn() };

    await daemon.respond(
      accepted,
      JSON.stringify({
        token: daemon.token,
        session: 'default',
        command: { kind: 'list' },
      })
    );
    await daemon.respond(
      rejected,
      JSON.stringify({
        token: 'wrong-token',
        session: 'default',
        command: { kind: 'list' },
      })
    );

    expect(JSON.parse(accepted.end.mock.calls[0][0].trim()).ok).toBe(true);
    expect(JSON.parse(rejected.end.mock.calls[0][0].trim())).toEqual({
      ok: false,
      message: 'Unauthorized daemon request',
    });
  });
});
