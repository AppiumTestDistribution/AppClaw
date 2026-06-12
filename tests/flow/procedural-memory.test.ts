import { describe, expect, it } from 'vitest';
import {
  computeGoalFingerprint,
  getBestProcedureCandidate,
  MIN_PROC_SCORE,
  retrieveProcedure,
  type ProcedureEntry,
  type ProcedureStore,
} from '../../src/memory/procedures.js';

function procedure(overrides: Partial<ProcedureEntry> = {}): ProcedureEntry {
  const goalKeywords = overrides.goalKeywords ?? ['tap', 'search', 'icon', 'top', 'screen'];
  return {
    id: overrides.id ?? 'proc-1',
    namespace: overrides.namespace ?? 'default',
    platform: overrides.platform ?? 'android',
    appId: overrides.appId ?? 'com.google.android.youtube',
    goalFingerprint: overrides.goalFingerprint ?? computeGoalFingerprint(goalKeywords),
    goalKeywords,
    agentMode: overrides.agentMode ?? 'vision',
    steps: overrides.steps ?? [
      {
        toolName: 'find_and_click',
        selector: 'magnifying glass search icon in the top right corner',
      },
    ],
    stepsInRun: overrides.stepsInRun ?? 1,
    timestamp: overrides.timestamp ?? Date.now(),
    confidence: overrides.confidence ?? 1,
    successCount: overrides.successCount ?? 1,
    failCount: overrides.failCount ?? 0,
    appVersion: overrides.appVersion,
  };
}

describe('procedural memory retrieval', () => {
  it('accepts useful rephrased sub-goal matches after repeated success', () => {
    const store: ProcedureStore = {
      version: 1,
      entries: [procedure({ successCount: 2 })],
    };

    const match = retrieveProcedure(store, {
      namespace: 'default',
      platform: 'android',
      appId: 'com.google.android.youtube',
      goalKeywords: ['tap', 'search', 'icon', 'type', 'appium', 'field'],
      agentMode: 'vision',
    });

    expect(match?.score).toBeGreaterThanOrEqual(MIN_PROC_SCORE);
    expect(match?.entry.id).toBe('proc-1');
  });

  it('rejects weak single-success fuzzy matches', () => {
    const store: ProcedureStore = {
      version: 1,
      entries: [procedure()],
    };

    const query = {
      namespace: 'default',
      platform: 'android' as const,
      appId: 'com.google.android.youtube',
      goalKeywords: ['tap', 'search', 'icon', 'type', 'appium', 'field'],
      agentMode: 'vision' as const,
    };

    expect(retrieveProcedure(store, query)).toBeUndefined();
    expect(getBestProcedureCandidate(store, query)?.entry.id).toBe('proc-1');
  });

  it('exposes the best rejected candidate for debug output', () => {
    const store: ProcedureStore = {
      version: 1,
      entries: [procedure({ goalKeywords: ['tap', 'back', 'button', 'top', 'left', 'return'] })],
    };

    const query = {
      namespace: 'default',
      platform: 'android' as const,
      appId: 'com.google.android.youtube',
      goalKeywords: ['select', 'video', 'search', 'results'],
      agentMode: 'vision' as const,
    };

    expect(retrieveProcedure(store, query)).toBeUndefined();
    expect(getBestProcedureCandidate(store, query)?.entry.id).toBe('proc-1');
  });
});
