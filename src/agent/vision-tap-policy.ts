/**
 * Vision-mode tap policy: when the LLM names a single keypad/timer key, raw tapX/tapY
 * from the screenshot is error-prone (adjacent keys, backspace). Prefer vision locate
 * (same idea as tree-index taps in tools like Droidrun — use a dedicated localizer, not
 * a one-shot normalized guess).
 */

export function shouldPreferVisionLocateTap(selector: string): boolean {
  const s = selector.toLowerCase();
  if (!s.trim()) return false;

  if (/backspace|delete key|\bx\b.*(keypad|numpad|number)|(keypad|numpad).*\bx\b/.test(s)) {
    return true;
  }
  if (/\bdigit\s*[0-9]\b/.test(s)) return true;
  if (/\bkey\s*[0-9]\b/.test(s)) return true;
  if (/\bnumber\s*[0-9]\b/.test(s)) return true;
  if (/\b[0-9]\s*(key|button|digit)\b/.test(s)) return true;
  if (/\b(press|tap)\s+[0-9]\b/.test(s)) return true;
  if (/\bdouble\s*0\b|\b00\b.*(key|button)/.test(s)) return true;

  return false;
}
