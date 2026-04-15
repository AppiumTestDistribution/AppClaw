/**
 * Screen state comparison for stuck detection.
 * Works with both trimmed DOM strings and legacy CompactUIElement arrays.
 */

import { createHash } from 'crypto';
import type { UIElement, CompactUIElement } from './types.js';
import { extractTexts } from './dom-trimmer.js';

/**
 * Perception hash for stuck detection and per-screen failure caches.
 * When DOM is unavailable (vision-only runs), fingerprints the screenshot so
 * real UI changes (e.g. timer digits) still advance the hash.
 */
export function computePerceptionHash(dom: string, screenshot?: string): string {
  const trimmed = dom.trim();
  if (trimmed.length > 0) {
    return computeScreenHash(trimmed);
  }
  if (screenshot && screenshot.length > 0) {
    return createHash('md5')
      .update(`img:${screenshot.length}:`)
      .update(screenshot.slice(0, 32768))
      .digest('hex');
  }
  return computeScreenHash('');
}

/** Compute a hash for screen state comparison. */
export function computeScreenHash(input: string | UIElement[] | CompactUIElement[]): string {
  if (typeof input === 'string') {
    // Hash the trimmed DOM string
    return createHash('md5').update(input).digest('hex');
  }
  // Legacy: hash element texts/ids
  const parts = input.map((e) => {
    const id = 'id' in e ? e.id : '';
    return `${id}|${e.text}|${e.center[0]},${e.center[1]}`;
  });
  return parts.join(';');
}

export interface ScreenDiff {
  changed: boolean;
  addedCount: number;
  removedCount: number;
  summary: string;
}

/** Diff two screen states to describe what changed. */
export function diffScreen(
  prev: string | UIElement[] | CompactUIElement[],
  curr: string | UIElement[] | CompactUIElement[]
): ScreenDiff {
  const prevIsFirst = typeof prev === 'string' ? prev === '' : prev.length === 0;

  if (prevIsFirst) {
    return {
      changed: true,
      addedCount: 0,
      removedCount: 0,
      summary: 'Initial screen loaded',
    };
  }

  const prevHash = computeScreenHash(prev);
  const currHash = computeScreenHash(curr);

  if (prevHash === currHash) {
    return {
      changed: false,
      addedCount: 0,
      removedCount: 0,
      summary: 'Screen NOT changed — your last action may have had no visible effect',
    };
  }

  // Extract text values for diff summary
  const prevTexts = new Set(
    typeof prev === 'string' ? extractTexts(prev) : prev.map((e) => e.text).filter(Boolean)
  );
  const currTexts = new Set(
    typeof curr === 'string' ? extractTexts(curr) : curr.map((e) => e.text).filter(Boolean)
  );

  const added = [...currTexts].filter((t) => !prevTexts.has(t));
  const removed = [...prevTexts].filter((t) => !currTexts.has(t));

  const parts: string[] = [];
  if (added.length > 0) parts.push(`New: ${added.slice(0, 5).join(', ')}`);
  if (removed.length > 0) parts.push(`Gone: ${removed.slice(0, 5).join(', ')}`);

  return {
    changed: true,
    addedCount: added.length,
    removedCount: removed.length,
    summary: parts.join('. ') || 'Screen layout changed',
  };
}
