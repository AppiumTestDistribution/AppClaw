import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { AgentDaemonState } from './server.js';
import { LOCK_PATH, METADATA_PATH, SOCKET_PATH, STATE_DIR, type DaemonMetadata } from './paths.js';
import type { DaemonRequest } from './types.js';

const IDLE_TIMEOUT_MS = Number(process.env.APPCLAW_AGENT_IDLE_TIMEOUT_MS ?? 30000);

export class AgentDaemon {
  private readonly token = randomBytes(32).toString('hex');
  private readonly state = new AgentDaemonState();
  private server: Server | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  async start(): Promise<void> {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    await rm(SOCKET_PATH, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(SOCKET_PATH, resolve);
    });
    await chmod(SOCKET_PATH, 0o600);

    const metadata: DaemonMetadata = {
      pid: process.pid,
      socketPath: SOCKET_PATH,
      token: this.token,
    };
    await writeFile(METADATA_PATH, JSON.stringify(metadata), { mode: 0o600 });
    process.once('SIGTERM', () => void this.stop());
    process.once('SIGINT', () => void this.stop());
    this.refreshIdleTimer();
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.state.closeAll();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    await Promise.allSettled([
      rm(SOCKET_PATH, { force: true }),
      rm(METADATA_PATH, { force: true }),
      rm(LOCK_PATH, { force: true }),
    ]);
    process.exitCode = 0;
  }

  private accept(socket: Socket): void {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const raw = input.slice(0, newline);
      void this.respond(socket, raw);
    });
  }

  private async respond(socket: Socket, raw: string): Promise<void> {
    try {
      const request = JSON.parse(raw) as DaemonRequest;
      if (request.token !== this.token) {
        socket.end(`${JSON.stringify({ ok: false, message: 'Unauthorized daemon request' })}\n`);
        return;
      }
      const response = await this.state.execute(request.session, request.command);
      socket.end(`${JSON.stringify(response)}\n`);
      this.refreshIdleTimer();
    } catch (error) {
      socket.end(
        `${JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        })}\n`
      );
    }
  }

  private refreshIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.state.sessionCount > 0) return;
    this.idleTimer = setTimeout(() => void this.stop(), IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }
}
