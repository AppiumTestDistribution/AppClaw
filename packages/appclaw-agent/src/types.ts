import type { AgentOpenOptions, AgentSelector, AgentTarget } from 'appclaw/agent-runtime';

export type Command =
  | { kind: 'open'; options: AgentOpenOptions }
  | { kind: 'snapshot'; interactiveOnly: boolean }
  | { kind: 'press'; target: TargetInput; vision?: string }
  | { kind: 'fill'; target: TargetInput; text: string }
  | { kind: 'longpress'; target: TargetInput; duration?: number }
  | { kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right'; target?: TargetInput }
  | { kind: 'key'; key: 'BACK' | 'HOME' | 'ENTER' }
  | { kind: 'getText'; target: TargetInput }
  | { kind: 'getAttrs'; target: TargetInput }
  | { kind: 'getInfo'; vision: string }
  | { kind: 'isVisible'; target?: TargetInput; text?: string; vision?: string }
  | { kind: 'wait'; condition: 'visible' | 'gone'; target?: TargetInput; text?: string }
  | { kind: 'screenshot'; path: string }
  | { kind: 'list' }
  | { kind: 'close' };

export type TargetInput =
  | { ref: string }
  | { selector: AgentSelector }
  | { text: string }
  | { coordinates: [number, number] };

export interface ParsedInvocation {
  session: string;
  json: boolean;
  local?: 'help' | 'version';
  command?: Command;
}

export interface DaemonRequest {
  token: string;
  session: string;
  command: Command;
}

export interface CommandResponse {
  ok: boolean;
  session?: string;
  message: string;
  data?: unknown;
  output?: string;
  /** Set when vision was requested but not configured. Read this image file to answer the visualQuery visually. */
  screenshotPath?: string;
  visualQuery?: string;
}

export interface SnapshotRef {
  ref: string;
  target: AgentTarget;
}
