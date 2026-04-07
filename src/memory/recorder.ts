/**
 * Episodic Memory — trajectory recorder.
 *
 * Captures winning actions during an agent run and saves them
 * to the trajectory store on successful completion.
 */

import type { TrajectoryEntry, TrajectoryStore } from './types.js';
import type { TrajectoryMatch } from './types.js';
import { addTrajectory, loadStore, saveStore, markStale } from './store.js';
import {
  extractScreenLabels,
  computeSemanticFingerprint,
  extractGoalKeywords,
  extractAppIdFromDom,
  extractAppIdFromText,
} from './fingerprint.js';

/** Actions worth remembering (skip navigation/meta actions) */
const RECORDABLE_ACTIONS = new Set(['find_and_click', 'find_and_type', 'launch_app']);

/** A step captured during the run */
interface RecordedStep {
  screenLabels: string[];
  screenFingerprint: string;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  appId: string;
}

export class EpisodicRecorder {
  private steps: RecordedStep[] = [];
  private goalKeywords: string[];
  private platform: 'android' | 'ios';
  private agentMode: 'dom' | 'vision';
  private storePath?: string;
  currentAppId: string = '';
  /** IDs of trajectories that were injected as hints — track for staleness */
  private injectedTrajectoryIds: Set<string> = new Set();

  constructor(
    goal: string,
    platform: 'android' | 'ios',
    agentMode: 'dom' | 'vision',
    storePath?: string
  ) {
    this.goalKeywords = extractGoalKeywords(goal);
    this.platform = platform;
    this.agentMode = agentMode;
    this.storePath = storePath;

    // Try to extract app ID from goal text (e.g., "open com.whatsapp")
    const fromGoal = extractAppIdFromText(goal);
    if (fromGoal) this.currentAppId = fromGoal;
  }

  /** Update detected platform (may change after first screen state) */
  setPlatform(platform: 'android' | 'ios'): void {
    this.platform = platform;
  }

  /** Update current app ID from DOM or launch_app action */
  setAppId(appId: string): void {
    if (appId) this.currentAppId = appId;
  }

  /** Try to detect app ID from DOM content */
  detectAppIdFromDom(dom: string): void {
    if (!this.currentAppId) {
      const detected = extractAppIdFromDom(dom);
      if (detected) this.currentAppId = detected;
    }
  }

  /** Track which trajectory IDs were injected as hints */
  trackInjectedTrajectories(matches: TrajectoryMatch[]): void {
    for (const m of matches) {
      this.injectedTrajectoryIds.add(m.entry.id);
    }
  }

  /**
   * Record a step during the run.
   * Only captures recordable actions (find_and_click, find_and_type, launch_app).
   */
  recordStep(dom: string, toolName: string, args: Record<string, unknown>, success: boolean): void {
    if (!RECORDABLE_ACTIONS.has(toolName)) return;

    // Update app ID from launch_app
    if (toolName === 'launch_app' && args.appId) {
      this.currentAppId = String(args.appId);
    }

    // Try to detect app from DOM if not yet known
    if (!this.currentAppId && dom) {
      this.detectAppIdFromDom(dom);
    }

    let screenLabels = extractScreenLabels(dom);
    // In vision mode DOM is empty — use goal keywords as fallback labels
    if (screenLabels.length === 0) {
      screenLabels = this.goalKeywords;
    }
    const screenFingerprint = computeSemanticFingerprint(screenLabels);

    this.steps.push({
      screenLabels,
      screenFingerprint,
      toolName,
      args,
      success,
      appId: this.currentAppId,
    });
  }

  /**
   * Mark injected trajectories as stale when their suggested action failed.
   *
   * Call this when an action fails and the failing selector matches
   * one that was injected from past experience.
   */
  markFailedExperience(failedSelector: string): void {
    if (this.injectedTrajectoryIds.size === 0) return;

    try {
      const store = loadStore(this.storePath);
      let changed = false;
      for (const id of this.injectedTrajectoryIds) {
        const entry = store.entries.find((e) => e.id === id);
        if (entry && entry.action.selector === failedSelector) {
          markStale(store, id);
          this.injectedTrajectoryIds.delete(id);
          changed = true;
        }
      }
      if (changed) saveStore(store, this.storePath);
    } catch {
      // Non-critical — don't crash the agent
    }
  }

  /**
   * Finalize the recording on successful completion.
   *
   * Extracts winning actions (successful steps) and saves each
   * as a trajectory entry in the persistent store.
   */
  finalize(stepsUsed: number): void {
    // For steps without an appId, backfill from the recorder's current appId
    // (which may have been set by a later launch_app action or detected from DOM)
    for (const step of this.steps) {
      if (!step.appId && this.currentAppId) {
        step.appId = this.currentAppId;
      }
    }

    const winningSteps = this.steps.filter(
      (s) => s.success && s.appId && RECORDABLE_ACTIONS.has(s.toolName)
    );

    if (winningSteps.length === 0) return;

    try {
      const store = loadStore(this.storePath);

      for (const step of winningSteps) {
        const entry: Omit<
          TrajectoryEntry,
          'id' | 'timestamp' | 'confidence' | 'successCount' | 'failCount'
        > = {
          platform: this.platform,
          appId: step.appId,
          screenFingerprint: step.screenFingerprint,
          screenLabels: step.screenLabels.slice(0, 15),
          goalKeywords: this.goalKeywords,
          agentMode: this.agentMode,
          action: {
            toolName: step.toolName,
            strategy: step.args.strategy as string | undefined,
            selector: String(step.args.selector ?? step.args.appId ?? ''),
            text: step.args.text as string | undefined,
          },
          stepsInRun: stepsUsed,
        };

        addTrajectory(store, entry);
      }

      saveStore(store, this.storePath);
    } catch {
      // Non-critical — don't crash the agent if disk write fails
    }
  }
}
