/**
 * Session logger — writes step-by-step execution logs to disk.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentResult, StepRecord } from './agent/loop.js';
import * as ui from './ui/terminal.js';

export class SessionLogger {
  private logDir: string;
  private sessionId: string;
  private steps: StepRecord[] = [];

  constructor(logDir: string) {
    this.logDir = logDir;
    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  logStep(record: StepRecord): void {
    this.steps.push(record);
  }

  finalize(goal: string, result: AgentResult): string {
    const log = {
      sessionId: this.sessionId,
      goal,
      success: result.success,
      reason: result.reason,
      stepsUsed: result.stepsUsed,
      timestamp: new Date().toISOString(),
      steps: this.steps,
    };

    const filename = `${this.sessionId}.json`;
    const filepath = join(this.logDir, filename);
    writeFileSync(filepath, JSON.stringify(log, null, 2));
    ui.printFileSaved('Session log:', filepath);
    return filepath;
  }
}
