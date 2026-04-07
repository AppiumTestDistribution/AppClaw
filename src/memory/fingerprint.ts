/**
 * Semantic screen fingerprinting and goal keyword extraction.
 *
 * Screen fingerprints are based on the top N short UI labels
 * (button text, menu items, field hints) — NOT dynamic content
 * like video titles or timestamps. This makes them stable across
 * sessions and devices running the same app version.
 */

import { createHash } from 'node:crypto';

/** Common words stripped from goals before keyword extraction */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'it',
  'this',
  'that',
  'be',
  'are',
  'was',
  'were',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'into',
  'if',
  'then',
  'than',
  'so',
  'up',
  'out',
  'about',
  'i',
  'me',
  'my',
  'we',
  'you',
  'your',
  'make',
  'sure',
  'please',
  'using',
  'use',
  'app',
  'device',
]);

/**
 * Extract short, stable UI labels from trimmed DOM XML.
 *
 * Filters out long strings (likely dynamic content) and keeps
 * only short labels that characterise the screen structure.
 */
export function extractScreenLabels(dom: string): string[] {
  if (!dom) return [];

  const labels: string[] = [];
  // Match text, desc, hint, content-desc, label attributes
  const attrRegex = /(?:text|desc|hint|content-desc|label)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(dom)) !== null) {
    const val = m[1].trim();
    // Keep only short UI labels (< 40 chars), skip empty / numeric-only
    if (val && val.length <= 40 && val.length >= 2 && !/^\d+$/.test(val)) {
      labels.push(val.toLowerCase());
    }
  }

  // Deduplicate and sort for stable hashing
  return [...new Set(labels)].sort();
}

/**
 * Compute a semantic fingerprint from screen labels.
 *
 * Takes the top 15 labels (sorted), joins them, and MD5 hashes.
 * Two screens with the same structural labels produce the same hash
 * even if dynamic content (timestamps, counts) differs.
 */
export function computeSemanticFingerprint(labels: string[]): string {
  const key = labels.slice(0, 15).join('|');
  return createHash('md5').update(key).digest('hex').slice(0, 12);
}

/**
 * Extract meaningful keywords from a goal string.
 *
 * Strips stop words and returns 3-6 lowercase keywords that
 * characterise the intent (e.g., "send", "message", "whatsapp").
 */
export function extractGoalKeywords(goal: string): string[] {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

  // Deduplicate, take top 6
  return [...new Set(words)].slice(0, 6);
}

/**
 * Extract the app package/bundle ID from DOM resource IDs.
 *
 * Android DOM elements have `rid="com.foo.bar:id/xyz"` — extract the package prefix.
 * Returns undefined if no package can be detected.
 */
export function extractAppIdFromDom(dom: string): string | undefined {
  if (!dom) return undefined;
  const match = dom.match(/rid="([a-z][a-z0-9_.]*):id\//);
  return match?.[1];
}

/**
 * Extract app package/bundle ID from a goal or action result string.
 *
 * Matches patterns like:
 * - "com.google.android.youtube"
 * - "Launched com.whatsapp"
 * - "activateApp("com.foo.bar")"
 */
export function extractAppIdFromText(text: string): string | undefined {
  const match = text.match(/\b(com\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,5})\b/);
  return match?.[1];
}
