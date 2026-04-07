/**
 * Smart element filtering — scores, deduplicates, and compacts UI elements.
 * Score, dedupe, and compact UI elements for LLM context.
 */

import type { UIElement, CompactUIElement } from './types.js';

/** Element types that have meaningful checked/unchecked states */
function isToggleType(type: string): boolean {
  const lower = type.toLowerCase();
  return (
    lower.includes('switch') ||
    lower.includes('toggle') ||
    lower.includes('checkbox') ||
    lower.includes('radio') ||
    lower.includes('checked')
  );
}

/** Strips a full UIElement to its compact form, omitting default-valued flags. */
export function compactElement(el: UIElement): CompactUIElement {
  const compact: CompactUIElement = {
    text: el.text,
    id: el.accessibilityId || el.id,
    center: el.center,
    action: el.action,
  };
  if (!el.enabled) compact.enabled = false;
  // Always show checked state for toggle-like elements (both true AND false)
  // so the LLM can see whether a switch is ON or OFF before acting
  if (isToggleType(el.type)) {
    compact.checked = el.checked;
  } else if (el.checked) {
    compact.checked = true;
  }
  if (el.focused) compact.focused = true;
  if (el.hint) compact.hint = el.hint;
  if (el.editable) compact.editable = true;
  if (el.scrollable) compact.scrollable = true;
  return compact;
}

/** Scores an element for relevance to the LLM. */
function scoreElement(el: UIElement): number {
  let score = 0;
  if (el.enabled) score += 10;
  if (el.editable) score += 8;
  if (el.focused) score += 6;
  if (el.clickable || el.longClickable) score += 5;
  if (el.text) score += 3;
  if (el.accessibilityId) score += 2;
  return score;
}

/**
 * Deduplicates elements by center coordinates (within tolerance),
 * scores them, and returns the top N as compact elements.
 */
export function filterElements(elements: UIElement[], limit: number): CompactUIElement[] {
  // Deduplicate by center coordinates (5px tolerance)
  const seen = new Map<string, UIElement>();
  for (const el of elements) {
    const bucketX = Math.round(el.center[0] / 5) * 5;
    const bucketY = Math.round(el.center[1] / 5) * 5;
    const key = `${bucketX},${bucketY}`;
    const existing = seen.get(key);
    if (!existing || scoreElement(el) > scoreElement(existing)) {
      seen.set(key, el);
    }
  }

  // Score, sort descending, take top N
  const deduped = Array.from(seen.values());
  deduped.sort((a, b) => scoreElement(b) - scoreElement(a));
  return deduped.slice(0, limit).map(compactElement);
}
