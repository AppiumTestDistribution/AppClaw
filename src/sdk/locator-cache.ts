/**
 * SDK locator cache — persists the (strategy, selector) that resolved an
 * element on a given screen so the next `app.run("tap Login")` against the
 * same app+screen can skip page-source fetch + DOM parse + scoring +
 * multi-strategy probe and go straight to one `findElement(strategy, selector)`
 * call.
 *
 * DOM mode only. Vision mode's synthetic `ai-element:x,y:[bbox]` UUID is
 * screenshot-bound (pixel coords don't survive resolution / theme changes),
 * so we skip it cleanly here.
 *
 * Appium element UUIDs are per-session — they change every new Appium
 * session — so we cache the strategy/selector pair, never the UUID itself.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const DEFAULT_STORE_DIR = join(homedir(), '.appclaw');
const DEFAULT_STORE_FILE = 'locator-cache.json';
const MAX_ENTRIES_PER_APP = 200;
/** Confidence half-life in days — older entries decay. Matches trajectory store. */
const HALF_LIFE_DAYS = 30;
/** Entries with effective confidence below this are evicted on next save. */
const DEAD_THRESHOLD = 0.05;

export type LocatorStrategy = 'accessibility id' | 'id' | 'xpath';

export type LocatorActionKind = 'tap' | 'type' | 'longPress' | 'swipe' | 'drag' | 'scrollAssert';

export interface LocatorCacheEntry {
  id: string;
  namespace: string;
  platform: 'android' | 'ios';
  appId: string;
  appVersion?: string;
  screenFingerprint: string;
  screenLabels: string[];
  actionKind: LocatorActionKind;
  /** Target label being resolved (e.g. "Login", "Email", "first slider"). */
  label: string;
  locator: {
    strategy: LocatorStrategy;
    selector: string;
    /** For xpath rebuilding when only text was available at record time. */
    text?: string;
  };
  successCount: number;
  failCount: number;
  confidence: number;
  timestamp: number;
}

export interface LocatorCacheStore {
  version: 1;
  entries: LocatorCacheEntry[];
}

export interface LocatorCacheKey {
  namespace: string;
  platform: 'android' | 'ios';
  appId: string;
  appVersion?: string;
  screenFingerprint: string;
  actionKind: LocatorActionKind;
  label: string;
}

/**
 * Opaque context passed down the SDK call chain. Holds the loaded store
 * (a single in-memory ref shared across all run() calls in an instance)
 * plus settings that don't change between calls.
 */
export interface LocatorCacheCtx {
  store: LocatorCacheStore;
  namespace: string;
  path: string;
  /**
   * Best-known active app ID from a preceding openApp/launchApp step. Some
   * apps, especially React Native demos, expose no resource-id attrs in DOM,
   * so the cache cannot infer appId from page source alone.
   */
  currentAppId?: string;
  /** True once a hit/miss/stale has mutated the store and a save is owed. */
  dirty: boolean;
}

/**
 * Per-call cache context propagated through `runOneInstruction` →
 * `executeStep` → the action helpers (`tapByLabel`, `flowTypeText`, …)
 * via AsyncLocalStorage. This avoids threading a new parameter through
 * 6 helper signatures: the SDK sets the context once in `runOneInstruction`
 * and any helper that wants to participate calls `getActiveLocatorCache()`.
 *
 * Returns `undefined` when:
 *  - the SDK ran without `locatorCache` enabled, OR
 *  - the call originated from a non-SDK path (YAML flow runner, replayer,
 *    goal agent loop) — those never set the context, so behavior is
 *    byte-identical to today.
 */
export const locatorCacheStorage = new AsyncLocalStorage<LocatorCacheCtx | undefined>();

/** Helper alias — clearer at call sites than `locatorCacheStorage.getStore()`. */
export function getActiveLocatorCache(): LocatorCacheCtx | undefined {
  return locatorCacheStorage.getStore();
}

function getStorePath(overridePath?: string): string {
  if (overridePath) return overridePath;
  return join(DEFAULT_STORE_DIR, DEFAULT_STORE_FILE);
}

export function getLocatorCachePath(overridePath?: string): string {
  return getStorePath(overridePath);
}

/** Load the cache from disk. Returns an empty store if the file is missing or corrupt. */
export function loadCache(overridePath?: string): LocatorCacheStore {
  const path = getStorePath(overridePath);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      return parsed as LocatorCacheStore;
    }
  } catch {
    // missing / corrupt — start fresh
  }
  return { version: 1, entries: [] };
}

/** Atomic write — temp file + rename. Same pattern as the trajectory store. */
export function saveCache(store: LocatorCacheStore, overridePath?: string): void {
  const path = getStorePath(overridePath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmp = path + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, path);
}

/**
 * Effective confidence with time decay and reliability penalty.
 * confidence * e^(-ageDays/halfLife) * (success / (success + fail))
 */
export function getEffectiveConfidence(entry: LocatorCacheEntry): number {
  const ageDays = (Date.now() - entry.timestamp) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.exp(-ageDays / HALF_LIFE_DAYS);
  const reliability =
    entry.failCount === 0 ? 1.0 : entry.successCount / (entry.successCount + entry.failCount);
  return entry.confidence * timeDecay * reliability;
}

function keyMatches(entry: LocatorCacheEntry, key: LocatorCacheKey): boolean {
  return (
    entry.namespace === key.namespace &&
    entry.platform === key.platform &&
    entry.appId === key.appId &&
    (entry.appVersion ?? '') === (key.appVersion ?? '') &&
    entry.screenFingerprint === key.screenFingerprint &&
    entry.actionKind === key.actionKind &&
    entry.label === key.label
  );
}

/**
 * Look up the best cached locator for the given key, or null if none.
 * If multiple entries match the key (shouldn't happen — recordHit upserts —
 * but defensive), returns the one with the highest effective confidence.
 */
export function lookupLocator(
  store: LocatorCacheStore,
  key: LocatorCacheKey
): LocatorCacheEntry | null {
  let best: LocatorCacheEntry | null = null;
  let bestConf = -Infinity;
  for (const entry of store.entries) {
    if (!keyMatches(entry, key)) continue;
    const conf = getEffectiveConfidence(entry);
    if (conf > bestConf) {
      best = entry;
      bestConf = conf;
    }
  }
  return best;
}

/**
 * Record a successful resolution. If an entry already exists for the key:
 *   - bump successCount, refresh timestamp
 *   - if the new winning locator differs from what was stored, overwrite —
 *     the freshest winner is the most predictive
 * Otherwise push a new entry and evict the weakest per-(namespace, app)
 * entries if over the cap.
 */
export function recordHit(
  store: LocatorCacheStore,
  key: LocatorCacheKey,
  screenLabels: string[],
  locator: LocatorCacheEntry['locator']
): LocatorCacheEntry {
  const existing = store.entries.find((e) => keyMatches(e, key));
  if (existing) {
    existing.successCount += 1;
    existing.timestamp = Date.now();
    // Freshest winner wins — strategy may legitimately shift if app changes.
    existing.locator = locator;
    existing.screenLabels = screenLabels;
    return existing;
  }

  const full: LocatorCacheEntry = {
    id: randomUUID(),
    namespace: key.namespace,
    platform: key.platform,
    appId: key.appId,
    appVersion: key.appVersion,
    screenFingerprint: key.screenFingerprint,
    screenLabels,
    actionKind: key.actionKind,
    label: key.label,
    locator,
    successCount: 1,
    failCount: 0,
    confidence: 1.0,
    timestamp: Date.now(),
  };
  store.entries.push(full);

  // Per-(namespace, app) eviction — keep chatty apps from starving others.
  const appEntries = store.entries.filter(
    (e) => e.namespace === key.namespace && e.appId === key.appId
  );
  if (appEntries.length > MAX_ENTRIES_PER_APP) {
    appEntries.sort((a, b) => getEffectiveConfidence(a) - getEffectiveConfidence(b));
    const toRemove = new Set(
      appEntries.slice(0, appEntries.length - MAX_ENTRIES_PER_APP).map((e) => e.id)
    );
    store.entries = store.entries.filter((e) => !toRemove.has(e.id));
  }

  return full;
}

/**
 * Mark an entry as stale — its cached locator failed at runtime.
 * Increments failCount, decays confidence by 0.2. Removes the entry once
 * effective confidence drops below DEAD_THRESHOLD so dead locators don't
 * keep mispredicting on every run.
 */
export function markStale(store: LocatorCacheStore, entryId: string): void {
  const entry = store.entries.find((e) => e.id === entryId);
  if (!entry) return;

  entry.failCount += 1;
  entry.confidence = Math.max(0, entry.confidence - 0.2);

  if (getEffectiveConfidence(entry) < DEAD_THRESHOLD) {
    store.entries = store.entries.filter((e) => e.id !== entryId);
  }
}
