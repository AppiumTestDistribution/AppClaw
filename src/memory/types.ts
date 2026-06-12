/**
 * Episodic Memory — cross-session trajectory store types.
 *
 * The agent remembers successful interactions indexed by
 * (platform, app, screen fingerprint, goal keywords) so it can
 * skip exploration on repeat tasks.
 */

/** A single stored trajectory — one winning action on one screen */
export interface TrajectoryEntry {
  id: string;
  platform: 'android' | 'ios';
  appId: string;
  /**
   * Scoping namespace — isolates memories across users/CI lanes/branches.
   * Legacy entries (pre-namespace) are treated as "default".
   */
  namespace?: string;
  /**
   * App version captured at record time. When both the entry and query have a
   * version, a mismatch hard-filters the entry from retrieval. Undefined on
   * either side disables the filter (legacy-safe).
   */
  appVersion?: string;
  /** Semantic hash of top screen labels — stable across devices */
  screenFingerprint: string;
  /** The actual text labels used to compute the fingerprint (for debug) */
  screenLabels: string[];
  /** Extracted keywords from the goal */
  goalKeywords: string[];

  // ── What worked ──
  agentMode: 'dom' | 'vision';
  action: {
    toolName: string;
    /** DOM mode: "accessibility id" | "id" | "xpath" */
    strategy?: string;
    /** DOM: exact selector value; Vision: visual description */
    selector: string;
    /** For find_and_type */
    text?: string;
  };

  // ── Metadata ──
  /** Total steps the full run took */
  stepsInRun: number;
  timestamp: number;
  confidence: number;
  successCount: number;
  failCount: number;
}

/** The full persisted store */
export interface TrajectoryStore {
  version: 1;
  entries: TrajectoryEntry[];
}

/** Query parameters for retrieving relevant trajectories */
export interface TrajectoryQuery {
  platform: 'android' | 'ios';
  appId: string;
  /** Scoping namespace — must match entry's namespace (or "default" for legacy). */
  namespace?: string;
  /**
   * App version. When set, entries with a different non-empty appVersion are
   * filtered out. When undefined, no version filter is applied.
   */
  appVersion?: string;
  currentScreenLabels: string[];
  goalKeywords: string[];
  agentMode: 'dom' | 'vision';
  maxResults?: number;
}

/** A scored match from the retriever */
export interface TrajectoryMatch {
  entry: TrajectoryEntry;
  score: number;
}
