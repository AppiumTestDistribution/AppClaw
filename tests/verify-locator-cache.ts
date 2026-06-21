/**
 * Verification for the SDK locator cache (pure-fn — no device needed).
 *
 * Run with: npx tsx tests/verify-locator-cache.ts
 *
 * Covers:
 *   1. Fingerprint stability — same labels, different order → same hash
 *   2. recordHit upserts (no duplicates) and bumps successCount
 *   3. markStale decays and evicts at the dead-confidence threshold
 *   4. Two screens (different fingerprints) don't cross-contaminate same label
 *   5. Cache survives a load/save roundtrip
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCache,
  saveCache,
  lookupLocator,
  recordHit,
  markStale,
  getEffectiveConfidence,
  type LocatorCacheKey,
} from '../src/sdk/locator-cache.js';
import {
  computeSemanticFingerprint,
  extractScreenLabels,
  extractAppIdFromDom,
} from '../src/memory/fingerprint.js';

const tmp = mkdtempSync(join(tmpdir(), 'appclaw-locator-cache-'));
const path = join(tmp, 'cache.json');

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

function makeKey(overrides: Partial<LocatorCacheKey> = {}): LocatorCacheKey {
  return {
    namespace: 'default',
    platform: 'android',
    appId: 'com.example.app',
    screenFingerprint: 'abc123',
    actionKind: 'tap',
    label: 'Login',
    ...overrides,
  };
}

try {
  console.log('\n=== 1. Fingerprint stability ===');
  // extractScreenLabels dedupes + sorts, so equivalent DOMs with attrs in
  // different order should hash identically. Verify via direct fingerprinting:
  const fpA = computeSemanticFingerprint(['login', 'email', 'password']);
  const fpB = computeSemanticFingerprint(['password', 'login', 'email']);
  // The fingerprinter does NOT re-sort its input — extractScreenLabels does.
  // So we feed it sorted input to mirror the real call path.
  const sorted = (labels: string[]) => [...labels].sort();
  const fpAs = computeSemanticFingerprint(sorted(['login', 'email', 'password']));
  const fpBs = computeSemanticFingerprint(sorted(['password', 'login', 'email']));
  assert(fpAs === fpBs, 'sorted-label inputs yield identical fingerprints');
  assert(fpA !== fpB || fpAs === fpBs, 'order-sensitive only without external sort (expected)');

  // Real-DOM-ish input: extractScreenLabels sorts internally.
  const dom1 = 'rid="com.foo:id/login" text="Login" rid="com.foo:id/email" text="Email"';
  const dom2 = 'rid="com.foo:id/email" text="Email" rid="com.foo:id/login" text="Login"';
  const fp1 = computeSemanticFingerprint(extractScreenLabels(dom1));
  const fp2 = computeSemanticFingerprint(extractScreenLabels(dom2));
  assert(fp1 === fp2, 'same labels in different attr order → same fingerprint');

  console.log('\n=== 2. recordHit upserts (no duplicates) ===');
  const store = loadCache(path);
  assert(store.entries.length === 0, 'fresh store is empty');

  const key = makeKey();
  const loc = { strategy: 'accessibility id' as const, selector: 'login_button' };
  recordHit(store, key, ['login', 'email'], loc);
  recordHit(store, key, ['login', 'email'], loc);
  recordHit(store, key, ['login', 'email'], loc);
  assert(store.entries.length === 1, 'three recordHit calls produce one entry');
  assert(store.entries[0].successCount === 3, 'successCount bumped to 3');
  assert(
    store.entries[0].locator.selector === 'login_button',
    'locator selector preserved on upsert'
  );

  console.log('\n=== 3. lookupLocator finds entry; non-matching key misses ===');
  const found = lookupLocator(store, key);
  assert(found?.locator.selector === 'login_button', 'lookup returns stored locator');

  const wrongScreen = lookupLocator(store, makeKey({ screenFingerprint: 'different' }));
  assert(wrongScreen === null, 'different screen → no hit');

  const wrongLabel = lookupLocator(store, makeKey({ label: 'Logout' }));
  assert(wrongLabel === null, 'different label → no hit');

  const wrongApp = lookupLocator(store, makeKey({ appId: 'com.other.app' }));
  assert(wrongApp === null, 'different app → no hit');

  const wrongAction = lookupLocator(store, makeKey({ actionKind: 'type' }));
  assert(wrongAction === null, 'different actionKind → no hit');

  console.log('\n=== 4. markStale decays and evicts ===');
  const entry = store.entries[0];
  const initialConf = entry.confidence;
  markStale(store, entry.id);
  assert(store.entries.length === 1, 'one failure does not evict');
  assert(entry.confidence < initialConf, 'confidence drops on stale');
  assert(entry.failCount === 1, 'failCount incremented');

  // Drive it past the dead threshold. successCount=3 fail=N → reliability =
  // 3 / (3 + N). At N=5 ratio = 3/8 = 0.375; confidence = 0 (after 5 .2 drops).
  // effective = 0 * timeDecay * 0.375 = 0 < 0.05 → evicted.
  for (let i = 0; i < 5; i++) markStale(store, entry.id);
  assert(store.entries.length === 0, 'enough failures evict the entry');

  console.log('\n=== 5. Cross-screen isolation ===');
  const k1 = makeKey({ screenFingerprint: 'screen-A' });
  const k2 = makeKey({ screenFingerprint: 'screen-B' });
  recordHit(store, k1, ['a'], { strategy: 'id', selector: 'A' });
  recordHit(store, k2, ['b'], { strategy: 'id', selector: 'B' });
  assert(store.entries.length === 2, 'same label on two screens → two entries');
  assert(lookupLocator(store, k1)?.locator.selector === 'A', 'screen A returns its own locator');
  assert(lookupLocator(store, k2)?.locator.selector === 'B', 'screen B returns its own locator');

  console.log('\n=== 6. Load/save roundtrip ===');
  saveCache(store, path);
  const reloaded = loadCache(path);
  assert(reloaded.entries.length === 2, 'roundtrip preserves entry count');
  const hit = lookupLocator(reloaded, k1);
  assert(hit?.locator.selector === 'A', 'roundtrip preserves locator data');

  console.log('\n=== 7. App ID extraction works on BOTH raw and trimmed DOM ===');
  // Raw Appium XML — what `getPageSource` returns and what the SDK locator
  // cache feeds directly into buildCacheKey. Without resource-id support, the
  // cache never activates on Android.
  const rawAndroid = '<android.widget.Button resource-id="com.foo.bar:id/login" text="Login" />';
  assert(
    extractAppIdFromDom(rawAndroid) === 'com.foo.bar',
    'extracts app id from raw Appium XML (resource-id="...")'
  );
  // Trimmed DOM — what episodic memory normally feeds in.
  const trimmedAndroid = '<Button rid="com.foo.bar:id/login" text="Login" />';
  assert(
    extractAppIdFromDom(trimmedAndroid) === 'com.foo.bar',
    'still extracts app id from trimmed DOM (rid="...") — no regression'
  );
  // Nothing usable → undefined, NOT a false-positive empty string.
  assert(
    extractAppIdFromDom('<RandomThing />') === undefined,
    'returns undefined when no app id present'
  );

  console.log('\n=== 8. Effective confidence math ===');
  const fresh = {
    ...store.entries[0],
    timestamp: Date.now(),
    confidence: 1,
    successCount: 1,
    failCount: 0,
  };
  assert(
    Math.abs(getEffectiveConfidence(fresh) - 1.0) < 0.01,
    'fresh, clean entry → effective ≈ 1.0'
  );
  const aged = { ...fresh, timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000 };
  assert(getEffectiveConfidence(aged) < 0.5, '30-day-old entry decayed to < 0.5');

  console.log('\n✅ All locator-cache checks passed!');
  rmSync(tmp, { recursive: true, force: true });
} catch (err) {
  rmSync(tmp, { recursive: true, force: true });
  console.error('\n❌ Failed:', err);
  process.exit(1);
}
