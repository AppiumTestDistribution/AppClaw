/**
 * Action recorder — records MCP tool calls during agent execution
 * as a replayable flow file (JSON).
 *
 * Use case: run a goal once with AI, record the steps, replay
 * deterministically later without LLM costs.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { ToolCallDecision } from '../llm/provider.js';
import type { CompactUIElement } from '../perception/types.js';
import * as ui from '../ui/terminal.js';

export interface RecordedStep {
  step: number;
  timestamp: number;
  action: ToolCallDecision;
  /** Snapshot of key screen elements at time of action (for adaptive replay) */
  contextElements: ContextElement[];
  /** Result of the action */
  result: string;
  /** Vision info if AI vision was used for this step */
  vision?: VisionInfo;
}

/** Minimal element info stored for adaptive replay matching */
export interface ContextElement {
  text: string;
  id: string;
  center: [number, number];
  action: string;
}

/** Whether a step used AI vision for element finding */
export interface VisionInfo {
  /** The natural language description used for vision find */
  description: string;
  /** The coordinates returned by vision */
  coordinates: [number, number];
}

export interface Recording {
  id: string;
  goal: string;
  platform: 'android' | 'ios';
  createdAt: string;
  steps: RecordedStep[];
  metadata: {
    totalSteps: number;
    success: boolean;
    durationMs: number;
  };
}

export class ActionRecorder {
  private steps: RecordedStep[] = [];
  private startTime: number;
  private platform: 'android' | 'ios' = 'android';

  constructor(
    private goal: string,
    private outputDir: string = 'recordings'
  ) {
    this.startTime = Date.now();
  }

  setPlatform(platform: 'android' | 'ios'): void {
    this.platform = platform;
  }

  /** Record a step during agent execution */
  record(
    step: number,
    action: ToolCallDecision,
    screenElements: CompactUIElement[],
    result: string,
    vision?: VisionInfo
  ): void {
    this.steps.push({
      step,
      timestamp: Date.now() - this.startTime,
      action,
      contextElements: screenElements.slice(0, 10).map((el) => ({
        text: el.text,
        id: el.id,
        center: el.center,
        action: el.action,
      })),
      result,
      ...(vision && { vision }),
    });
  }

  /** Save the recording to a JSON file */
  save(success: boolean): string {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    const id = `rec-${Date.now()}`;
    const recording: Recording = {
      id,
      goal: this.goal,
      platform: this.platform,
      createdAt: new Date().toISOString(),
      steps: this.steps,
      metadata: {
        totalSteps: this.steps.length,
        success,
        durationMs: Date.now() - this.startTime,
      },
    };

    const filename = `${id}.json`;
    const filepath = join(this.outputDir, filename);
    writeFileSync(filepath, JSON.stringify(recording, null, 2));
    ui.printFileSaved('Recording:', filepath);
    return filepath;
  }

  /** Get step count */
  get stepCount(): number {
    return this.steps.length;
  }
}
