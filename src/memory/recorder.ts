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
import {
  addProcedure,
  computeGoalFingerprint,
  loadProcedures,
  saveProcedures,
  type ProcedureStep,
} from './procedures.js';

/** Actions worth remembering (skip navigation/meta actions) */
const RECORDABLE_ACTIONS = new Set(['find_and_click', 'find_and_type', 'launch_app']);

/**
 * Selectors so generic they describe an unrelated dialog button on a thousand
 * different screens. Storing them creates retrieval noise without ever helping.
 * Vision-mode descriptions like "OK button" are the main offenders; DOM-mode
 * resource IDs / xpaths almost never collide with this list.
 */
const GENERIC_SELECTOR_PATTERN =
  /^\s*(ok|okay|yes|no|allow|deny|cancel|skip|close|dismiss|done|next|back|continue|got it|maybe later|no thanks|later|don'?t allow|accept|agree|i agree|confirm)( button)?\s*$/i;

function isGenericSelector(selector: string): boolean {
  if (!selector) return false;
  return GENERIC_SELECTOR_PATTERN.test(selector);
}

/** A step captured during the run */
interface RecordedStep {
  screenLabels: string[];
  screenFingerprint: string;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  appId: string;
}

export interface EpisodicRecorderOptions {
  storePath?: string;
  /** Override path for the procedural memory store. */
  procedureStorePath?: string;
  /** Scoping namespace ("default" if omitted). */
  namespace?: string;
  /** App version captured at session start (optional). */
  appVersion?: string;
}

export class EpisodicRecorder {
  private steps: RecordedStep[] = [];
  private goalKeywords: string[];
  private platform: 'android' | 'ios';
  private agentMode: 'dom' | 'vision';
  private storePath?: string;
  private procedureStorePath?: string;
  private namespace: string;
  private appVersion?: string;
  currentAppId: string = '';
  /** IDs of trajectories that were injected as hints — track for staleness */
  private injectedTrajectoryIds: Set<string> = new Set();
  /** ID of the procedure injected as a plan — for staleness on failure. */
  private injectedProcedureId?: string;

  constructor(
    goal: string,
    platform: 'android' | 'ios',
    agentMode: 'dom' | 'vision',
    optsOrStorePath?: string | EpisodicRecorderOptions
  ) {
    this.goalKeywords = extractGoalKeywords(goal);
    this.platform = platform;
    this.agentMode = agentMode;

    // Backwards-compatible: accept a bare path string or an options object.
    if (typeof optsOrStorePath === 'string') {
      this.storePath = optsOrStorePath;
      this.namespace = 'default';
    } else {
      this.storePath = optsOrStorePath?.storePath;
      this.procedureStorePath = optsOrStorePath?.procedureStorePath;
      this.namespace = optsOrStorePath?.namespace ?? 'default';
      this.appVersion = optsOrStorePath?.appVersion;
    }

    // Try to extract app ID from goal text (e.g., "open com.whatsapp")
    const fromGoal = extractAppIdFromText(goal);
    if (fromGoal) this.currentAppId = fromGoal;
  }

  /** Update detected app version (e.g., once MCP returns it). */
  setAppVersion(version: string): void {
    if (version) this.appVersion = version;
  }

  /** Read-only accessors used by procedural memory + telemetry. */
  getNamespace(): string {
    return this.namespace;
  }
  getAppVersion(): string | undefined {
    return this.appVersion;
  }
  getGoalKeywords(): string[] {
    return this.goalKeywords;
  }
  getPlatform(): 'android' | 'ios' {
    return this.platform;
  }
  getAgentMode(): 'dom' | 'vision' {
    return this.agentMode;
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

  /** Track which procedure was injected as the plan (for staleness on failure). */
  trackInjectedProcedure(procedureId: string): void {
    this.injectedProcedureId = procedureId;
  }

  /** Read-only: the procedure id currently injected, if any. */
  getInjectedProcedureId(): string | undefined {
    return this.injectedProcedureId;
  }

  /**
   * Record a step during the run.
   * Only captures recordable actions (find_and_click, find_and_type, launch_app).
   */
  recordStep(dom: string, toolName: string, args: Record<string, unknown>, success: boolean): void {
    if (!RECORDABLE_ACTIONS.has(toolName)) return;

    // Hygiene: skip selectors so generic they'd be noise on future retrieval.
    // launch_app uses appId (never a generic word) so this only filters click/type.
    if (toolName !== 'launch_app') {
      const selector = String(args.selector ?? '');
      if (isGenericSelector(selector)) return;
    }

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
          namespace: this.namespace,
          appVersion: this.appVersion,
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

    // ── Procedural memory: store the ordered sequence as a recipe ──
    // One procedure per run keyed by goal fingerprint. Multi-step runs
    // benefit most; single-step runs are still saved so retrieval can
    // promote them on the second occurrence.
    try {
      const procedureSteps: ProcedureStep[] = winningSteps.map((step) => ({
        toolName: step.toolName,
        strategy: step.args.strategy as string | undefined,
        selector: String(step.args.selector ?? step.args.appId ?? ''),
        text: step.args.text as string | undefined,
        screenLabelsHint: step.screenLabels.slice(0, 5),
      }));

      // Use the appId from the first recordable step that has one.
      const procedureAppId = winningSteps.find((s) => s.appId)?.appId || this.currentAppId || '';
      if (procedureAppId && procedureSteps.length > 0) {
        const procStore = loadProcedures(this.procedureStorePath);
        addProcedure(procStore, {
          namespace: this.namespace,
          platform: this.platform,
          appId: procedureAppId,
          appVersion: this.appVersion,
          goalFingerprint: computeGoalFingerprint(this.goalKeywords),
          goalKeywords: this.goalKeywords,
          agentMode: this.agentMode,
          steps: procedureSteps,
          stepsInRun: stepsUsed,
        });
        saveProcedures(procStore, this.procedureStorePath);
      }
    } catch {
      // Non-critical — don't crash the agent if procedural disk write fails
    }
  }
}
