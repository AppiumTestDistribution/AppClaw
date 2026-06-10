import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = join(homedir(), '.appclaw', 'agent-cli');
export const SOCKET_PATH = join(STATE_DIR, 'daemon.sock');
export const METADATA_PATH = join(STATE_DIR, 'daemon.json');
export const LOCK_PATH = join(STATE_DIR, 'daemon.lock');

export interface DaemonMetadata {
  pid: number;
  socketPath: string;
  token: string;
}
