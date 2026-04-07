/**
 * Episodic Memory — JSON file-based trajectory store.
 *
 * Persists successful trajectories to ~/.appclaw/trajectories.json.
 * Supports atomic writes, per-app eviction, and confidence decay.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { TrajectoryEntry, TrajectoryStore } from './types.js';

const DEFAULT_STORE_DIR = join(homedir(), '.appclaw');
const DEFAULT_STORE_FILE = 'trajectories.json';
const MAX_ENTRIES_PER_APP = 100;
/** Confidence half-life in days — older entries decay */
const HALF_LIFE_DAYS = 30;

function getStorePath(overridePath?: string): string {
  if (overridePath) return overridePath;
  return join(DEFAULT_STORE_DIR, DEFAULT_STORE_FILE);
}

/** Load the trajectory store from disk. Returns empty store if not found. */
export function loadStore(overridePath?: string): TrajectoryStore {
  const path = getStorePath(overridePath);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      return parsed as TrajectoryStore;
    }
  } catch {
    // File doesn't exist or is corrupted — start fresh
  }
  return { version: 1, entries: [] };
}

/** Save the store atomically (write to temp, then rename). */
export function saveStore(store: TrajectoryStore, overridePath?: string): void {
  const path = getStorePath(overridePath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmp = path + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, path);
}

/**
 * Effective confidence with time decay.
 *
 * confidence * e^(-ageDays/halfLife) * successRate
 */
export function getEffectiveConfidence(entry: TrajectoryEntry): number {
  const ageDays = (Date.now() - entry.timestamp) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.exp(-ageDays / HALF_LIFE_DAYS);
  // Reliability: penalize failures but don't punish new entries.
  // 1 success, 0 fails → 1.0. 1 success, 1 fail → 0.5. 3 success, 1 fail → 0.75.
  const reliability =
    entry.failCount === 0 ? 1.0 : entry.successCount / (entry.successCount + entry.failCount);
  return entry.confidence * timeDecay * reliability;
}

/**
 * Add a trajectory entry to the store.
 *
 * If a matching entry already exists (same app + screen + goal + selector),
 * increment its successCount instead of creating a duplicate.
 * Evicts lowest-confidence entries when over the per-app limit.
 */
export function addTrajectory(
  store: TrajectoryStore,
  entry: Omit<TrajectoryEntry, 'id' | 'timestamp' | 'confidence' | 'successCount' | 'failCount'>
): TrajectoryStore {
  // Check for existing match — same app, screen, and tool action.
  // For vision mode, selectors are natural-language descriptions that vary
  // between runs (e.g., "search icon top right" vs "magnifying glass icon top right corner").
  // Match on: platform + app + screen fingerprint + tool name (NOT exact selector).
  // When a match is found, keep the selector with the highest successCount.
  const existing = store.entries.find(
    (e) =>
      e.platform === entry.platform &&
      e.appId === entry.appId &&
      e.screenFingerprint === entry.screenFingerprint &&
      e.action.toolName === entry.action.toolName
  );

  if (existing) {
    existing.successCount += 1;
    existing.timestamp = Date.now();
    existing.stepsInRun = Math.min(existing.stepsInRun, entry.stepsInRun);
    // Keep the new selector if it's shorter (more concise = often better for vision)
    if (entry.action.selector.length < existing.action.selector.length) {
      existing.action.selector = entry.action.selector;
    }
    // Merge goal keywords
    const mergedKw = [...new Set([...existing.goalKeywords, ...entry.goalKeywords])];
    existing.goalKeywords = mergedKw.slice(0, 10);
    return store;
  }

  // New entry
  const full: TrajectoryEntry = {
    ...entry,
    id: randomUUID(),
    timestamp: Date.now(),
    confidence: 1.0,
    successCount: 1,
    failCount: 0,
  };
  store.entries.push(full);

  // Evict if over per-app limit
  const appEntries = store.entries.filter((e) => e.appId === entry.appId);
  if (appEntries.length > MAX_ENTRIES_PER_APP) {
    // Sort by effective confidence, remove the weakest
    appEntries.sort((a, b) => getEffectiveConfidence(a) - getEffectiveConfidence(b));
    const toRemove = new Set(
      appEntries.slice(0, appEntries.length - MAX_ENTRIES_PER_APP).map((e) => e.id)
    );
    store.entries = store.entries.filter((e) => !toRemove.has(e.id));
  }

  return store;
}

/**
 * Mark a trajectory as stale (its recalled action failed at runtime).
 *
 * Increments failCount and reduces confidence.
 * If confidence drops below 0.1, the entry is removed.
 */
export function markStale(store: TrajectoryStore, entryId: string): TrajectoryStore {
  const entry = store.entries.find((e) => e.id === entryId);
  if (!entry) return store;

  entry.failCount += 1;
  entry.confidence = Math.max(0, entry.confidence - 0.2);

  // Remove if effectively dead
  if (getEffectiveConfidence(entry) < 0.05) {
    store.entries = store.entries.filter((e) => e.id !== entryId);
  }

  return store;
}
