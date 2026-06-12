/**
 * Procedural Memory — multi-step recipes.
 *
 * Where episodic memory remembers a single winning action on a screen,
 * procedural memory remembers the *ordered sequence* of actions that
 * achieved a particular goal in a particular app. On a new run with a
 * matching goal, the recorded plan is injected into the LLM prompt as a
 * hint — the LLM still has to verify against the live screen, but it
 * starts with an outline instead of exploring from scratch.
 *
 * Storage is JSON at ~/.appclaw/procedures.json (override via
 * PROCEDURAL_MEMORY_PATH). Keyed by (namespace, platform, appId,
 * goalFingerprint), where goalFingerprint is a stable hash of the sorted
 * goal keywords.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const DEFAULT_STORE_DIR = join(homedir(), '.appclaw');
const DEFAULT_STORE_FILE = 'procedures.json';
const MAX_PROCEDURES_PER_APP = 30;
const HALF_LIFE_DAYS = 30;

/** One step in a stored procedure. */
export interface ProcedureStep {
  toolName: string;
  /** DOM mode: "accessibility id" | "id" | "xpath" — undefined in vision mode. */
  strategy?: string;
  selector: string;
  text?: string;
  /** Top labels of the screen the step ran on — used to format the plan. */
  screenLabelsHint?: string[];
}

/** A stored multi-step recipe for one goal. */
export interface ProcedureEntry {
  id: string;
  namespace: string;
  platform: 'android' | 'ios';
  appId: string;
  appVersion?: string;
  /** Stable hash of sorted goalKeywords — primary retrieval key. */
  goalFingerprint: string;
  goalKeywords: string[];
  agentMode: 'dom' | 'vision';
  steps: ProcedureStep[];
  stepsInRun: number;
  timestamp: number;
  confidence: number;
  successCount: number;
  failCount: number;
}

export interface ProcedureStore {
  version: 1;
  entries: ProcedureEntry[];
}

export interface ProcedureQuery {
  namespace: string;
  platform: 'android' | 'ios';
  appId: string;
  appVersion?: string;
  goalKeywords: string[];
  agentMode: 'dom' | 'vision';
}

function getProcedureStorePath(overridePath?: string): string {
  if (overridePath) return overridePath;
  return join(DEFAULT_STORE_DIR, DEFAULT_STORE_FILE);
}

/** Resolved procedure store path (respects PROCEDURAL_MEMORY_PATH overrides). */
export function getProceduresStorePath(overridePath?: string): string {
  return getProcedureStorePath(overridePath);
}

/** Stable fingerprint for a goal, based on its keywords. */
export function computeGoalFingerprint(goalKeywords: string[]): string {
  const key = [...goalKeywords].sort().join('|');
  return createHash('md5').update(key).digest('hex').slice(0, 12);
}

export function loadProcedures(overridePath?: string): ProcedureStore {
  const path = getProcedureStorePath(overridePath);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries as ProcedureEntry[]) {
        if (!entry.namespace) entry.namespace = 'default';
      }
      return parsed as ProcedureStore;
    }
  } catch {
    // Missing or corrupt — start fresh.
  }
  return { version: 1, entries: [] };
}

export function saveProcedures(store: ProcedureStore, overridePath?: string): void {
  const path = getProcedureStorePath(overridePath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = path + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, path);
}

function getEffectiveProcedureConfidence(entry: ProcedureEntry): number {
  const ageDays = (Date.now() - entry.timestamp) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.exp(-ageDays / HALF_LIFE_DAYS);
  const reliability =
    entry.failCount === 0 ? 1.0 : entry.successCount / (entry.successCount + entry.failCount);
  return entry.confidence * timeDecay * reliability;
}

/**
 * Add a procedure to the store. If a matching procedure already exists
 * (same namespace+platform+app+version+goal+mode), increment its successCount
 * and replace the steps with the shorter (more efficient) sequence.
 */
export function addProcedure(
  store: ProcedureStore,
  entry: Omit<ProcedureEntry, 'id' | 'timestamp' | 'confidence' | 'successCount' | 'failCount'>
): ProcedureStore {
  const existing = store.entries.find(
    (e) =>
      e.namespace === entry.namespace &&
      e.platform === entry.platform &&
      e.appId === entry.appId &&
      (e.appVersion ?? '') === (entry.appVersion ?? '') &&
      e.goalFingerprint === entry.goalFingerprint &&
      e.agentMode === entry.agentMode
  );

  if (existing) {
    existing.successCount += 1;
    existing.timestamp = Date.now();
    // Prefer the shorter sequence — fewer steps means a more efficient path.
    if (entry.steps.length > 0 && entry.steps.length < existing.steps.length) {
      existing.steps = entry.steps;
      existing.stepsInRun = entry.stepsInRun;
    }
    return store;
  }

  const full: ProcedureEntry = {
    ...entry,
    id: randomUUID(),
    timestamp: Date.now(),
    confidence: 1.0,
    successCount: 1,
    failCount: 0,
  };
  store.entries.push(full);

  // Per-(namespace, app) eviction.
  const scoped = store.entries.filter(
    (e) => e.appId === entry.appId && e.namespace === entry.namespace
  );
  if (scoped.length > MAX_PROCEDURES_PER_APP) {
    scoped.sort((a, b) => getEffectiveProcedureConfidence(a) - getEffectiveProcedureConfidence(b));
    const toRemove = new Set(
      scoped.slice(0, scoped.length - MAX_PROCEDURES_PER_APP).map((e) => e.id)
    );
    store.entries = store.entries.filter((e) => !toRemove.has(e.id));
  }

  return store;
}

export function markProcedureStale(store: ProcedureStore, entryId: string): ProcedureStore {
  const entry = store.entries.find((e) => e.id === entryId);
  if (!entry) return store;
  entry.failCount += 1;
  entry.confidence = Math.max(0, entry.confidence - 0.2);
  if (getEffectiveProcedureConfidence(entry) < 0.05) {
    store.entries = store.entries.filter((e) => e.id !== entryId);
  }
  return store;
}

/** Result of retrieveProcedure — includes the match score so the caller can log it. */
export interface ProcedureMatch {
  entry: ProcedureEntry;
  /** 0–1 Jaccard score on goalKeywords (1.0 = exact fingerprint match) */
  score: number;
  exactGoalFingerprint: boolean;
}

/** Minimum goal-keyword Jaccard required to consider a procedure relevant. */
export const MIN_PROC_SCORE = 0.3;
const MIN_SINGLE_SUCCESS_PROC_SCORE = 0.55;

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const item of setA) if (setB.has(item)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Retrieve the best matching procedure for a goal, or undefined if none.
 *
 * Hard filters: namespace, platform, app, (optional) appVersion. The original
 * design used exact goalFingerprint match, but the planner rephrases sub-goals
 * between runs (e.g. "Tap the search icon at the top" vs "Tap the search icon
 * and Type 'appium'") — same intent, totally different keyword sets. We now
 * use Jaccard similarity on goalKeywords with a min score, matching how
 * episodic retrieval works.
 *
 * Single-success procedures older than 7 days are suppressed (hygiene).
 */
export function retrieveProcedure(
  store: ProcedureStore,
  query: ProcedureQuery
): ProcedureMatch | undefined {
  const scored = getProcedureCandidates(store, query).filter((m) => isProcedureInjectable(m));

  if (scored.length === 0) return undefined;

  return sortProcedureMatches(scored, query)[0];
}

/**
 * Return the best procedure after hard filters, even when it is below the
 * injection threshold. Used for debug output so memory misses are explainable.
 */
export function getBestProcedureCandidate(
  store: ProcedureStore,
  query: ProcedureQuery
): ProcedureMatch | undefined {
  const scored = getProcedureCandidates(store, query);
  if (scored.length === 0) return undefined;
  return sortProcedureMatches(scored, query)[0];
}

function getProcedureCandidates(store: ProcedureStore, query: ProcedureQuery): ProcedureMatch[] {
  const goalFingerprint = computeGoalFingerprint(query.goalKeywords);
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  const scored: ProcedureMatch[] = [];
  for (const e of store.entries) {
    if (e.namespace !== query.namespace) continue;
    if (e.platform !== query.platform) continue;
    if (e.appId !== query.appId) continue;
    if (query.appVersion && e.appVersion && e.appVersion !== query.appVersion) continue;
    if (e.successCount < 2 && Date.now() - e.timestamp > SEVEN_DAYS) continue;

    // Exact fingerprint short-circuits to a perfect score; otherwise Jaccard.
    const exactGoalFingerprint = e.goalFingerprint === goalFingerprint;
    const score = exactGoalFingerprint ? 1.0 : jaccard(e.goalKeywords, query.goalKeywords);
    scored.push({ entry: e, score, exactGoalFingerprint });
  }

  return scored;
}

export function getProcedureInjectionThreshold(match: ProcedureMatch): number {
  if (match.exactGoalFingerprint) return MIN_PROC_SCORE;
  return match.entry.successCount >= 2 ? MIN_PROC_SCORE : MIN_SINGLE_SUCCESS_PROC_SCORE;
}

function isProcedureInjectable(match: ProcedureMatch): boolean {
  if (match.score >= 1) return true;
  return match.score >= getProcedureInjectionThreshold(match);
}

function sortProcedureMatches(matches: ProcedureMatch[], query: ProcedureQuery): ProcedureMatch[] {
  return matches.sort((a, b) => {
    // Score is dominant; ties broken by same-mode preference, then confidence.
    if (Math.abs(a.score - b.score) > 0.05) return b.score - a.score;
    const modeA = a.entry.agentMode === query.agentMode ? 1 : 0;
    const modeB = b.entry.agentMode === query.agentMode ? 1 : 0;
    if (modeA !== modeB) return modeB - modeA;
    return getEffectiveProcedureConfidence(b.entry) - getEffectiveProcedureConfidence(a.entry);
  });
}

/**
 * Format a procedure as a compact PLAN block for the LLM prompt.
 *
 * Targets ~150 tokens — the goal is to give the agent an outline, not a
 * verbatim script. The plan is always followed by a reminder that the LLM
 * should adapt to the current screen.
 */
export function formatProcedureForPrompt(entry: ProcedureEntry): string {
  const lines: string[] = [];
  const reuseCount = entry.successCount > 1 ? ` (succeeded ${entry.successCount}x)` : '';
  lines.push(`PREVIOUSLY SUCCESSFUL PLAN${reuseCount}:`);

  entry.steps.forEach((s, i) => {
    const n = i + 1;
    if (s.toolName === 'launch_app') {
      lines.push(`  ${n}. launch_app: ${s.selector}`);
    } else if (s.toolName === 'find_and_type') {
      const sel = s.selector ? ` on "${s.selector}"` : '';
      const text = s.text ? ` with "${s.text}"` : '';
      lines.push(`  ${n}. find_and_type${sel}${text}`);
    } else {
      const strat = s.strategy ? ` (${s.strategy})` : '';
      lines.push(`  ${n}. ${s.toolName}: "${s.selector}"${strat}`);
    }
  });

  lines.push(
    '(Adapt to the current screen — these are hints from a past run, not a literal script. Skip steps already done.)'
  );
  return lines.join('\n');
}
