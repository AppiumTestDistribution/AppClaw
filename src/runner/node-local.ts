/**
 * Local SSE node: spawn an appium-mcp `--httpStream` server on this machine and
 * expose its host/port so the runner (and every leased session) can connect via
 * the shared SSE client.
 *
 * Because the node runs on the same host as the control plane, the runner can
 * allocate free driver ports locally (see McpSession.buildParallelCaps) and pass
 * them per session — so the appium-mcp node-side port-allocation fix is NOT
 * required for the local-SSE step. It only becomes necessary for remote nodes.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import * as net from 'net';

/** Bind to port 0 to let the OS assign a free ephemeral port, then release it. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

/** True once something is accepting TCP connections on host:port. */
function isPortOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Resolve the appium-mcp entry the same way mcp/client.ts does: prefer the
 * bundled dependency's dist/index.js; fall back to npx if it can't be resolved.
 */
function resolveAppiumMcp(): { command: string; args: string[] } {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('appium-mcp/package.json');
    const bin = join(dirname(pkgJson), 'dist', 'index.js');
    return { command: process.execPath, args: [bin] };
  } catch {
    return { command: 'npx', args: ['--yes', 'appium-mcp'] };
  }
}

export interface SSENode {
  host: string;
  port: number;
  stop(): Promise<void>;
}

// ── Signal guard ────────────────────────────────────────────────────
// Every appium-mcp the runner spawns is tracked here so that a hard interrupt
// (Ctrl-C / SIGTERM / SIGHUP) or any process.exit() kills it. Without this the
// node would survive `run()`'s finally being skipped and orphan the server.

const activeChildren = new Set<ChildProcess>();
let guardsInstalled = false;

/**
 * Kill every tracked appium-mcp child (synchronous — safe in an `exit` handler).
 * Uses SIGKILL: appium-mcp's fastmcp httpStream server does not reliably exit on
 * SIGTERM, so a graceful signal can leave it orphaned. Per-test teardown already
 * deletes Appium sessions before the node is stopped, so force-killing it here is
 * clean.
 */
function killAllChildren(): void {
  for (const child of activeChildren) {
    if (!child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  activeChildren.clear();
}

/** Install process-level cleanup once, lazily on the first spawned node. */
function installSignalGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  // Normal/abnormal exit: best-effort synchronous kill.
  process.on('exit', killAllChildren);
  // Signals: kill children, then exit with the conventional code so the
  // terminal/CI sees the interrupt rather than a hung process.
  const signals: Array<[NodeJS.Signals, number]> = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ];
  for (const [sig, code] of signals) {
    process.once(sig, () => {
      killAllChildren();
      process.exit(code);
    });
  }
}

export interface StartLocalNodeOptions {
  /** Override the port (default: an OS-assigned free port). */
  port?: number;
  /** Stream appium-mcp stdout/stderr to the console. Default false. */
  debug?: boolean;
  /** Max time to wait for the server to accept connections. Default 30s. */
  readyTimeoutMs?: number;
}

/**
 * Spawn `appium-mcp --httpStream --port=<port>` and resolve once it's accepting
 * connections on `/sse`. Call `stop()` to kill it.
 */
export async function startLocalSSENode(opts: StartLocalNodeOptions = {}): Promise<SSENode> {
  const host = '127.0.0.1';
  const port = opts.port ?? (await findFreePort());
  const { command, args } = resolveAppiumMcp();

  const child: ChildProcess = spawn(command, [...args, '--httpStream', `--port=${port}`], {
    stdio: opts.debug ? 'inherit' : 'ignore',
    env: { ...process.env },
  });

  // Track for the signal guard so an interrupt never orphans this process.
  installSignalGuards();
  activeChildren.add(child);

  let exited = false;
  child.once('exit', () => {
    exited = true;
    activeChildren.delete(child);
  });

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `appium-mcp SSE node exited before becoming ready (port ${port}). ` +
          `Re-run with debug to see its output.`
      );
    }
    if (await isPortOpen(host, port)) {
      return {
        host,
        port,
        async stop() {
          activeChildren.delete(child);
          // SIGKILL: fastmcp's httpStream server doesn't reliably honor SIGTERM.
          if (!child.killed) child.kill('SIGKILL');
        },
      };
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!child.killed) child.kill();
  throw new Error(`appium-mcp SSE node did not become ready within timeout on port ${port}.`);
}
