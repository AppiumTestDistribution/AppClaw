/**
 * Recovery engine — checkpoint/rollback and alternative path generation.
 *
 * When the agent gets stuck, the recovery engine can:
 * 1. Record checkpoints (known-good screen states)
 * 2. Suggest rollback to a checkpoint via navigation (back/home)
 * 3. Generate alternative approaches for the current sub-goal
 */

import type { MCPClient } from '../mcp/types.js';
import { computeScreenHash } from '../perception/screen-diff.js';

export interface Checkpoint {
  step: number;
  screenHash: string;
  /** Action history leading to this checkpoint */
  actionPath: string[];
}

export interface RecoveryEngine {
  /** Save a checkpoint at the current state */
  checkpoint(step: number, dom: string, actionPath: string[]): void;
  /** Get the most recent checkpoint */
  getLastCheckpoint(): Checkpoint | null;
  /** Get all checkpoints */
  getCheckpoints(): Checkpoint[];
  /** Attempt to rollback to the last checkpoint via back/home navigation */
  rollback(mcp: MCPClient): Promise<RollbackResult>;
  /** Generate alternative action suggestions based on failure history */
  suggestAlternatives(failedActions: string[]): string[];
  /** Reset all checkpoints */
  reset(): void;
}

export interface RollbackResult {
  success: boolean;
  stepsBack: number;
  message: string;
}

export function createRecoveryEngine(): RecoveryEngine {
  const checkpoints: Checkpoint[] = [];

  return {
    checkpoint(step, dom, actionPath) {
      const screenHash = computeScreenHash(dom);

      // Don't save duplicate consecutive checkpoints
      const last = checkpoints.at(-1);
      if (last && last.screenHash === screenHash) return;

      checkpoints.push({
        step,
        screenHash,
        actionPath: [...actionPath],
      });

      // Keep max 10 checkpoints
      if (checkpoints.length > 10) checkpoints.shift();
    },

    getLastCheckpoint() {
      return checkpoints.at(-1) ?? null;
    },

    getCheckpoints() {
      return [...checkpoints];
    },

    async rollback(mcp: MCPClient): Promise<RollbackResult> {
      // Conservative rollback: press BACK only once.
      // Multiple BACK presses are destructive — they can exit the current screen,
      // discard in-progress work, or navigate away from the target app entirely.
      // A single BACK is usually enough to dismiss an overlay/popup.
      try {
        await mcp.callTool('appium_mobile_press_key', { key: 'BACK' });
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        return {
          success: false,
          stepsBack: 0,
          message: 'Back navigation failed',
        };
      }

      return {
        success: true,
        stepsBack: 1,
        message:
          'Pressed BACK once to dismiss overlay/popup. WARNING: Verify the screen — if you left the current screen or target app, the goal may need to be restarted.',
      };
    },

    suggestAlternatives(failedActions): string[] {
      const suggestions: string[] = [];
      const failedSet = new Set(failedActions);

      if (failedSet.has('appium_click') || failedSet.has('appium_find_element')) {
        suggestions.push('Try a different locator strategy (accessibility id, xpath, or id)');
        suggestions.push('Try scrolling to reveal the element first');
        suggestions.push('The action may have already succeeded — check if the goal is complete');
      }

      if (failedSet.has('appium_set_value')) {
        suggestions.push(
          'Find the actual EditText element — the current target may be a label/container'
        );
        suggestions.push('Try clicking the field first to ensure it has focus');
        suggestions.push(
          'For Compose/custom UI: the input may be a View with a long desc — click it first; the next screen may show the real editable field'
        );
      }

      if (failedSet.has('appium_scroll') || failedSet.has('scroll')) {
        suggestions.push('Stop scrolling — interact with currently visible elements instead');
      }

      if (suggestions.length === 0) {
        suggestions.push('Try going home and relaunching the target app');
        suggestions.push('Try a completely different navigation path to reach your goal');
      }

      return suggestions;
    },

    reset() {
      checkpoints.length = 0;
    },
  };
}
