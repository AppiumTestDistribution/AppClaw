/**
 * JSON event emitter for --json mode.
 *
 * Emits newline-delimited JSON (NDJSON) events to stdout,
 * enabling machine-readable output for IDE extensions, CI, etc.
 */

export type JsonEvent =
  | { event: 'connected'; data: { transport: string } }
  | { event: 'device_ready'; data: { platform: string; device?: string; mjpegUrl?: string } }
  | { event: 'plan'; data: { goal: string; subGoals: string[]; isComplex: boolean } }
  | { event: 'goal_start'; data: { goal: string; subGoalIndex: number; totalSubGoals: number } }
  | {
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
  | { event: 'screen'; data: { screenshot?: string; elementCount?: number } }
  | {
      event: 'goal_done';
      data: { goal: string; success: boolean; reason: string; stepsUsed: number };
    }
  | { event: 'hitl'; data: { type: string; prompt: string } }
  | {
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
  | {
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
  | {
      event: 'parallel_done';
      data: {
        success: boolean;
        passedCount: number;
        failedCount: number;
        reason?: string;
        workers?: unknown[];
      };
    }
  | {
      event: 'suite_done';
      data: {
        success: boolean;
        passedCount: number;
        failedCount: number;
        reason?: string;
        workers?: unknown[];
      };
    }
  | { event: 'error'; data: { message: string; detail?: string } }
  | { event: 'done'; data: { success: boolean; totalSteps: number; totalCost?: number } };

let jsonMode = false;

export function enableJsonMode(): void {
  jsonMode = true;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Emit a JSON event to stdout (NDJSON format) */
export function emitJson(event: JsonEvent): void {
  if (!jsonMode) return;
  process.stdout.write(JSON.stringify(event) + '\n');
}
