/**
 * Screen snapshot — captures visible text from the device DOM on demand.
 *
 * Used by `AppClaw.verify()` to surface "what is actually on screen right now"
 * when an assertion fails, so the error tells the user both what was expected
 * and what they actually got.
 */

import type { MCPClient } from '../mcp/types.js';
import { getPageSource } from '../mcp/tools.js';

const MAX_TEXTS = 25;
const MAX_TEXT_LEN = 80;

/**
 * Pull all human-readable strings from the current page source.
 * Returns an empty array if the page source can't be fetched (e.g. device
 * disconnected) — this is a best-effort debug aid, never a hard error.
 */
export async function snapshotVisibleTexts(client: MCPClient): Promise<string[]> {
  let dom: string;
  try {
    dom = await getPageSource(client);
  } catch {
    return [];
  }
  return extractVisibleTexts(dom);
}

/**
 * Pull `text=`, `content-desc=` (Android), `label=`, `name=`, `value=` (iOS)
 * attributes from the DOM. Deduped, trimmed, length-capped per entry, and
 * truncated to the top MAX_TEXTS so the error stays readable.
 */
export function extractVisibleTexts(dom: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /(?:text|content-desc|label|name|value)="([^"]+)"/g;
  for (const m of dom.matchAll(re)) {
    let t = m[1].trim();
    if (!t || t.length < 2) continue;
    // Skip pure numeric/UUID/bounds noise
    if (/^[\d.,;:\-\s]+$/.test(t)) continue;
    if (t.length > MAX_TEXT_LEN) t = t.slice(0, MAX_TEXT_LEN - 1) + '…';
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TEXTS) break;
  }
  return out;
}
