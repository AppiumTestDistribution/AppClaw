import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { LOCK_PATH, METADATA_PATH, SOCKET_PATH, STATE_DIR, type DaemonMetadata } from './paths.js';
import type { Command, CommandResponse, DaemonRequest } from './types.js';

export async function sendCommand(session: string, command: Command): Promise<CommandResponse> {
  const metadata = await ensureDaemon();
  return request(metadata, { token: metadata.token, session, command });
}

async function ensureDaemon(retryStaleLock = true): Promise<DaemonMetadata> {
  const current = await readDaemonMetadata();
  if (current && (await canConnect(current))) return current;

  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const ownsStartup = await acquireStartupLock();
  if (ownsStartup) {
    await Promise.allSettled([
      rm(METADATA_PATH, { force: true }),
      rm(SOCKET_PATH, { force: true }),
    ]);
    const entry = fileURLToPath(new URL('./daemon-entry.js', import.meta.url));
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const started = await readDaemonMetadata();
    if (started && (await canConnect(started))) {
      if (ownsStartup) await rm(LOCK_PATH, { force: true });
      return started;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await rm(LOCK_PATH, { force: true });
  if (!ownsStartup && retryStaleLock) {
    return ensureDaemon(false);
  }
  throw new Error('Timed out starting the appclaw-agent daemon');
}

async function acquireStartupLock(): Promise<boolean> {
  try {
    await writeFile(LOCK_PATH, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

async function readDaemonMetadata(): Promise<DaemonMetadata | null> {
  try {
    return JSON.parse(await readFile(METADATA_PATH, 'utf8')) as DaemonMetadata;
  } catch {
    return null;
  }
}

async function canConnect(metadata: DaemonMetadata): Promise<boolean> {
  try {
    const response = await request(metadata, {
      token: metadata.token,
      session: 'default',
      command: { kind: 'list' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

function request(metadata: DaemonMetadata, message: DaemonRequest): Promise<CommandResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(metadata.socketPath);
    let body = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      body += chunk;
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.once('end', () => {
      try {
        resolve(JSON.parse(body.trim()) as CommandResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}
