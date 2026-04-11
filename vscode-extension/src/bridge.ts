/**
 * AppclawBridge — spawns the appclaw CLI as a child process with --json flag
 * and parses NDJSON events into typed EventEmitter events.
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import * as vscode from 'vscode';

// Mirror the event types from appclaw's json-emitter.ts
export interface ConnectedEvent {
  event: 'connected';
  data: { transport: string };
}
export interface DeviceReadyEvent {
  event: 'device_ready';
  data: { platform: string; device?: string; mjpegUrl?: string };
}
export interface PlanEvent {
  event: 'plan';
  data: { goal: string; subGoals: string[]; isComplex: boolean };
}
export interface GoalStartEvent {
  event: 'goal_start';
  data: { goal: string; subGoalIndex: number; totalSubGoals: number };
}
export interface StepEvent {
  event: 'step';
  data: {
    step: number;
    action: string;
    target?: string;
    args?: Record<string, unknown>;
    success: boolean;
    message: string;
  };
}
export interface ScreenEvent {
  event: 'screen';
  data: { screenshot?: string; elementCount?: number };
}
export interface GoalDoneEvent {
  event: 'goal_done';
  data: { goal: string; success: boolean; reason: string; stepsUsed: number };
}
export interface HitlEvent {
  event: 'hitl';
  data: { type: string; prompt: string };
}
export interface FlowStepEvent {
  event: 'flow_step';
  data: {
    step: number;
    total: number;
    kind: string;
    target?: string;
    status: 'running' | 'passed' | 'failed';
    error?: string;
    message?: string;
    device?: string;
  };
}
export interface FlowDoneEvent {
  event: 'flow_done';
  data: {
    success: boolean;
    stepsExecuted: number;
    stepsTotal: number;
    failedAt?: number;
    reason?: string;
    failedPhase?: string;
    phaseResults?: unknown[];
  };
}
export interface WorkerResult {
  flowFile?: string;
  deviceName: string;
  success: boolean;
  stepsExecuted: number;
  stepsTotal: number;
  reason?: string;
}
export interface ParallelDoneEvent {
  event: 'parallel_done';
  data: {
    success: boolean;
    passedCount: number;
    failedCount: number;
    reason?: string;
    workers?: WorkerResult[];
  };
}
export interface SuiteDoneEvent {
  event: 'suite_done';
  data: {
    success: boolean;
    passedCount: number;
    failedCount: number;
    reason?: string;
    workers?: WorkerResult[];
  };
}
export interface ErrorEvent {
  event: 'error';
  data: { message: string; detail?: string };
}
export interface DoneEvent {
  event: 'done';
  data: { success: boolean; totalSteps: number; totalCost?: number };
}

export type AppclawEvent =
  | ConnectedEvent
  | DeviceReadyEvent
  | PlanEvent
  | GoalStartEvent
  | StepEvent
  | ScreenEvent
  | GoalDoneEvent
  | HitlEvent
  | FlowStepEvent
  | FlowDoneEvent
  | ParallelDoneEvent
  | SuiteDoneEvent
  | ErrorEvent
  | DoneEvent;

export interface AppclawBridgeEvents {
  event: [AppclawEvent];
  connected: [ConnectedEvent['data']];
  device_ready: [DeviceReadyEvent['data']];
  plan: [PlanEvent['data']];
  goal_start: [GoalStartEvent['data']];
  step: [StepEvent['data']];
  screen: [ScreenEvent['data']];
  goal_done: [GoalDoneEvent['data']];
  hitl: [HitlEvent['data']];
  flow_step: [FlowStepEvent['data']];
  flow_done: [FlowDoneEvent['data']];
  parallel_done: [ParallelDoneEvent['data']];
  suite_done: [SuiteDoneEvent['data']];
  error: [ErrorEvent['data']];
  done: [DoneEvent['data']];
  stderr: [string];
  exit: [number | null];
}

/** Build env vars from VS Code settings */
export function getEnvFromSettings(): Record<string, string> {
  const config = vscode.workspace.getConfiguration('appclaw');
  const env: Record<string, string> = {};

  // ── Agent mode + vision settings ─────────────────────────
  const agentMode = config.get<string>('agentMode', 'vision');
  const visionMode = config.get<string>('visionMode', 'fallback');

  env.AGENT_MODE = agentMode;

  if (agentMode === 'vision') {
    // Vision mode: always use vision (Stark)
    env.VISION_MODE = 'always';
  } else {
    // DOM mode: respect user's visionMode choice
    env.VISION_MODE = visionMode;
  }

  // ── Direct setting → env var mappings ───────────────────
  const mapping: Record<string, string> = {
    // LLM
    llmProvider: 'LLM_PROVIDER',
    llmApiKey: 'LLM_API_KEY',
    llmModel: 'LLM_MODEL',
    // Vision (Gemini key for Stark when provider ≠ gemini)
    geminiApiKey: 'GEMINI_API_KEY',
    // Device
    platform: 'PLATFORM',
    deviceType: 'DEVICE_TYPE',
    deviceUdid: 'DEVICE_UDID',
    deviceName: 'DEVICE_NAME',
    // Agent
    maxSteps: 'MAX_STEPS',
    stepDelay: 'STEP_DELAY',
    maxElements: 'MAX_ELEMENTS',
    llmThinking: 'LLM_THINKING',
    llmThinkingBudget: 'LLM_THINKING_BUDGET',
    llmScreenshotMaxEdgePx: 'LLM_SCREENSHOT_MAX_EDGE_PX',
    showTokenUsage: 'SHOW_TOKEN_USAGE',
    episodicMemory: 'EPISODIC_MEMORY',
    episodicMemoryPath: 'EPISODIC_MEMORY_PATH',
    // MCP Connection
    mcpTransport: 'MCP_TRANSPORT',
    mcpHost: 'MCP_HOST',
    mcpPort: 'MCP_PORT',
    // Cloud (credentials are set via .env, not VS Code settings)
    cloudProvider: 'CLOUD_PROVIDER',
    lambdatestDeviceName: 'LAMBDATEST_DEVICE_NAME',
    lambdatestOsVersion: 'LAMBDATEST_OS_VERSION',
    lambdatestBuildName: 'LAMBDATEST_BUILD_NAME',
    lambdatestProjectName: 'LAMBDATEST_PROJECT_NAME',
    lambdatestVideo: 'LAMBDATEST_VIDEO',
    lambdatestNetwork: 'LAMBDATEST_NETWORK',
    lambdatestApp: 'LAMBDATEST_APP',
    // Advanced
    mcpDebug: 'MCP_DEBUG',
  };

  for (const [settingKey, envKey] of Object.entries(mapping)) {
    const value = config.get<string | number | boolean>(settingKey);
    if (value === undefined || value === '') {
      continue;
    }
    if (typeof value === 'boolean') {
      env[envKey] = value ? 'true' : 'false';
    } else {
      env[envKey] = String(value);
    }
  }

  return env;
}

/** Get the CLI command from settings */
export function getCliCommand(): { command: string; baseArgs: string[] } {
  const cliPath = vscode.workspace.getConfiguration('appclaw').get<string>('cliPath', 'appclaw');

  const parts = cliPath.split(/\s+/);
  return {
    command: parts[0],
    baseArgs: parts.slice(1),
  };
}

export class AppclawBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stderrBuffer: string[] = [];
  /** Secret env vars (credentials from SecretStorage) — merged in at spawn time. */
  extraEnv: Record<string, string> = {};

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /** Run a natural-language goal */
  runGoal(goal: string, extraArgs: string[] = []): void {
    this.start(['--json', ...extraArgs, goal]);
  }

  /** Run a YAML flow file */
  runFlow(filePath: string, extraArgs: string[] = []): void {
    this.start(['--json', '--flow', filePath, ...extraArgs]);
  }

  /** Start persistent playground session */
  startPlayground(extraArgs: string[] = []): void {
    this.start(['--json', '--playground', ...extraArgs]);
  }

  /** Send a playground command to the running process */
  sendCommand(command: string): void {
    this.sendInput(command);
  }

  /** Send text input to stdin (for HITL responses) */
  sendInput(text: string): void {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(text + '\n');
    }
  }

  /** Gracefully stop the running process — sends SIGTERM to trigger cleanup (delete_session), then force-kills after timeout */
  stop(): void {
    if (this.proc) {
      const proc = this.proc;
      // SIGTERM triggers graceful shutdown (cleanup + delete_session) in the CLI
      proc.kill('SIGTERM');
      // Force-kill after 5s if process hasn't exited
      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 5000);
      proc.on('exit', () => clearTimeout(forceKillTimer));
      this.proc = null;
    }
  }

  private start(args: string[]): void {
    if (this.running) {
      this.stop();
    }

    const { command, baseArgs } = getCliCommand();
    const env = {
      ...process.env,
      ...getEnvFromSettings(),
      ...this.extraEnv,
    };

    // Use workspace folder as cwd so the CLI can create logs/, load .env, etc.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    this.stderrBuffer = [];
    this.proc = spawn(command, [...baseArgs, ...args], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Parse NDJSON from stdout
    if (this.proc.stdout) {
      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        try {
          const event = JSON.parse(trimmed) as AppclawEvent;
          if (event.event) {
            this.emit('event', event);
            this.emit(event.event, event.data);
          }
        } catch {
          // Non-JSON output — ignore (CLI might emit non-JSON on stdout in some edge cases)
        }
      });
    }

    // Collect stderr for diagnostics
    if (this.proc.stderr) {
      const rl = readline.createInterface({ input: this.proc.stderr });
      rl.on('line', (line) => {
        this.stderrBuffer.push(line);
        this.emit('stderr', line);
      });
    }

    this.proc.on('exit', (code) => {
      this.emit('exit', code);
      this.proc = null;
    });

    this.proc.on('error', (err) => {
      this.emit('error', { message: err.message });
      this.proc = null;
    });
  }

  /** Get collected stderr output (useful for error reporting) */
  getStderr(): string {
    return this.stderrBuffer.join('\n');
  }
}
