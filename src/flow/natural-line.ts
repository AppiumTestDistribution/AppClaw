/**
 * Parse a single natural-language flow line into a FlowStep (verbatim preserved for display).
 * Returns null if the line does not match any supported pattern — caller may error or fall through.
 */

import type { FlowStep } from './types.js';

function trimPunct(s: string): string {
  return s.replace(/[.!?]+$/g, '').trim();
}

/** Strip common natural-language prefixes like "the text", "text", "element" from captured text. */
function stripTextPrefix(s: string): string {
  return s.replace(/^(?:the\s+)?(?:text|element|label)\s+/i, '').trim();
}

/**
 * Try to interpret a human-readable instruction as a flow step.
 */
export function tryParseNaturalFlowLine(line: string): FlowStep | null {
  const t = line.trim();
  if (!t) return null;
  const verbatim = t;

  const openMatch = t.match(
    /^(?:open|launch|start|go\s+to)\s+(?:the\s+)?(.+?)(?:\s+(?:app|application))?$/i
  );
  if (openMatch) {
    const query = trimPunct(openMatch[1].trim());
    if (query) return { kind: 'openApp', query, verbatim };
  }

  // "navigate to X" / "go to X screen" — tap-style navigation
  const navigateMatch = t.match(
    /^navigate\s+to\s+(?:the\s+)?(.+?)(?:\s+(?:screen|page|tab|section|view))?$/i
  );
  if (navigateMatch) {
    const label = trimPunct(navigateMatch[1].trim());
    if (label) return { kind: 'tap', label, verbatim };
  }

  // "long press X" / "long-press X" / "long tap X" / "press and hold X"
  const longPressMatch = t.match(
    /^(?:long[\s-]press|long[\s-]tap|press\s+and\s+hold)(?:\s+on)?\s+(?:the\s+)?(.+?)(?:\s+for\s+(\d+(?:\.\d+)?)\s*(?:ms|milliseconds?|s|seconds?))?$/i
  );
  if (longPressMatch) {
    const label = trimPunct(longPressMatch[1].trim());
    const durRaw = longPressMatch[2];
    const durUnit =
      longPressMatch[0].match(/(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)$/i)?.[2] ?? 'ms';
    const duration = durRaw
      ? durUnit.startsWith('s')
        ? Math.round(Number(durRaw) * 1000)
        : Math.round(Number(durRaw))
      : undefined;
    if (label)
      return { kind: 'longPress', label, ...(duration != null ? { duration } : {}), verbatim };
  }

  const clickMatch = t.match(/^(?:click|tap|select|choose|pick)(?:\s+on)?\s+(?:the\s+)?(.+)$/i);
  if (clickMatch) {
    const label = trimPunct(clickMatch[1].trim());
    if (label) return { kind: 'tap', label, verbatim };
  }

  const pressMatch = t.match(/^press(?:\s+on)?\s+(?:the\s+)?(.+)$/i);
  if (pressMatch) {
    const label = trimPunct(pressMatch[1].trim());
    if (label) return { kind: 'tap', label, verbatim };
  }

  const typeMatch = t.match(/^(?:type|enter\s+text|input)\s+["'](.+)["']$/i);
  if (typeMatch) {
    return { kind: 'type', text: typeMatch[1], verbatim };
  }
  // "Type "X" in/into <target>" / "Enter 'X' in <target>" — quoted text + any target
  const typeQuotedInMatch = t.match(
    /^(?:type|enter|input)\s+["'](.+?)["']\s+(?:in|into)\s+(?:the\s+)?(.+)$/i
  );
  if (typeQuotedInMatch) {
    const text = typeQuotedInMatch[1].trim();
    const target = trimPunct(typeQuotedInMatch[2].trim());
    if (text) return { kind: 'type', text, target: target || undefined, verbatim };
  }
  // "Enter X in Y" / "Type X in Y" — unquoted text + target
  // Use greedy (.+) with \s+(?:in|into) so the last "in/into" wins.
  const typeInMatch = t.match(/^(?:type|enter|input)\s+(.+)\s+(?:in|into)\s+(?:the\s+)?(.+)$/i);
  if (typeInMatch) {
    const text = trimPunct(typeInMatch[1].trim());
    const target = trimPunct(typeInMatch[2].trim());
    if (text) return { kind: 'type', text, target: target || undefined, verbatim };
  }
  const typeBare = t.match(/^(?:type|input)\s+(.+)$/i);
  if (typeBare && !t.match(/^type\s*:/i)) {
    const text = trimPunct(typeBare[1].trim());
    if (text) return { kind: 'type', text, verbatim };
  }

  // "search for X" / "search X" / "look for X" / "find X" — type the query text
  const searchForMatch = t.match(/^(?:search|look|find)\s+(?:for\s+)?["']?(.+?)["']?$/i);
  if (searchForMatch && !t.match(/^(?:search|find)$/i)) {
    let text = trimPunct(searchForMatch[1].trim());
    // Check for "in <target>" destination
    const searchInMatch = text.match(/^(.+)\s+(?:in|into)\s+(?:the\s+)?(.+)$/i);
    if (searchInMatch) {
      const target = trimPunct(searchInMatch[2].trim());
      text = trimPunct(searchInMatch[1].trim());
      if (text) return { kind: 'type', text, target: target || undefined, verbatim };
    }
    if (text) return { kind: 'type', text, verbatim };
  }

  // "enter X" (bare, not "enter text X") — type the text
  const enterTextBare = t.match(/^enter\s+(?!text\b)["']?(.+?)["']?$/i);
  if (enterTextBare && !t.match(/^enter$/i)) {
    let text = trimPunct(enterTextBare[1].trim());
    const enterInMatch = text.match(/^(.+)\s+(?:in|into)\s+(?:the\s+)?(.+)$/i);
    if (enterInMatch) {
      const target = trimPunct(enterInMatch[2].trim());
      text = trimPunct(enterInMatch[1].trim());
      if (text) return { kind: 'type', text, target: target || undefined, verbatim };
    }
    if (text) return { kind: 'type', text, verbatim };
  }

  // scroll down until "X" is visible / scroll down 3 times to find "X"
  // MUST come before the simple swipe/scroll match to avoid premature matching
  const scrollAssertMatch = t.match(
    /^scroll\s+(up|down|left|right)\s+(?:(\d+)\s+times?\s+)?(?:until|to\s+(?:find|see|check|verify))\s+["']?(.+?)["']?\s*(?:is\s+(?:visible|present|shown|displayed|seen|found|there))?$/i
  );
  if (scrollAssertMatch) {
    const direction = scrollAssertMatch[1].toLowerCase() as 'up' | 'down' | 'left' | 'right';
    const maxScrolls = scrollAssertMatch[2] ? Number(scrollAssertMatch[2]) : 3;
    const text = stripTextPrefix(trimPunct(scrollAssertMatch[3].trim()));
    if (text) return { kind: 'scrollAssert', text, direction, maxScrolls, verbatim };
  }

  // "drag X to Y" / "slide X to Y" / "move X to Y"
  const dragMatch = t.match(/^(?:drag|slide|move)\s+(.+?)\s+(?:to|until|towards?)\s+(.+)$/i);
  if (dragMatch) {
    const from = trimPunct(dragMatch[1].trim());
    const to = trimPunct(dragMatch[2].trim());
    if (from && to) return { kind: 'drag', from, to, verbatim };
  }

  const swipeMatch = t.match(/^swipe\s+(up|down|left|right)(?:\s+(\d+)\s*(?:times?))?/i);
  if (swipeMatch) {
    const direction = swipeMatch[1].toLowerCase() as 'up' | 'down' | 'left' | 'right';
    const repeat = swipeMatch[2] ? parseInt(swipeMatch[2], 10) : undefined;
    return { kind: 'swipe', direction, ...(repeat && repeat > 1 ? { repeat } : {}), verbatim };
  }

  const scrollMatch = t.match(/^scroll\s+(up|down|left|right)(?:\s+(\d+)\s*(?:times?))?/i);
  if (scrollMatch) {
    const direction = scrollMatch[1].toLowerCase() as 'up' | 'down' | 'left' | 'right';
    const repeat = scrollMatch[2] ? parseInt(scrollMatch[2], 10) : undefined;
    return { kind: 'swipe', direction, ...(repeat && repeat > 1 ? { repeat } : {}), verbatim };
  }

  // ── waitUntil: "wait until screen is loaded", "wait until <text> is visible/gone" ──
  // Also: "wait 5s until ..." / "wait 10 seconds until ..."

  // "wait until screen is loaded/stable/ready" (with optional timeout)
  const waitScreenMatch = t.match(
    /^wait\s+(?:(\d+)\s*(?:s|sec|seconds?)?\s+)?(?:until|for|till)\s+(?:the\s+)?screen\s+(?:is\s+)?(?:loaded|stable|ready|settled|idle)$/i
  );
  if (waitScreenMatch) {
    const timeout = waitScreenMatch[1] ? Number(waitScreenMatch[1]) : 10;
    return { kind: 'waitUntil', condition: 'screenLoaded', timeoutSeconds: timeout, verbatim };
  }
  // Also match trailing timeout: "wait until screen is loaded 15s"
  const waitScreenMatch2 = t.match(
    /^wait\s+(?:until|for|till)\s+(?:the\s+)?screen\s+(?:is\s+)?(?:loaded|stable|ready|settled|idle)\s+(\d+)\s*(?:s|sec|seconds?)?$/i
  );
  if (waitScreenMatch2) {
    const timeout = Number(waitScreenMatch2[1]);
    return { kind: 'waitUntil', condition: 'screenLoaded', timeoutSeconds: timeout, verbatim };
  }

  // "wait [Ns] until <text> is visible/present/shown" OR "wait until <text> is visible [Ns]"
  // Also: "wait for <text> to be visible"
  const waitVisibleMatch = t.match(
    /^wait\s+(?:(\d+)\s*(?:s|sec|seconds?)?\s+)?(?:until|for|till)\s+["']?(.+?)["']?\s+(?:(?:is|to\s+be)\s+)?(?:visible|present|shown|displayed|appears?|exists?|loaded)(?:\s+(\d+)\s*(?:s|sec|seconds?)?)?$/i
  );
  if (waitVisibleMatch) {
    const text = stripTextPrefix(trimPunct(waitVisibleMatch[2].trim()));
    const timeout = waitVisibleMatch[1]
      ? Number(waitVisibleMatch[1])
      : waitVisibleMatch[3]
        ? Number(waitVisibleMatch[3])
        : 10;
    if (text)
      return { kind: 'waitUntil', condition: 'visible', text, timeoutSeconds: timeout, verbatim };
  }

  // "wait [Ns] until <text> is gone/hidden/invisible/disappears" OR trailing timeout
  // Also: "wait for <text> to be gone"
  const waitGoneMatch = t.match(
    /^wait\s+(?:(\d+)\s*(?:s|sec|seconds?)?\s+)?(?:until|for|till)\s+["']?(.+?)["']?\s+(?:(?:is|to\s+be)\s+)?(?:gone|hidden|invisible|disappeared?|removed|not\s+visible|not\s+shown)(?:\s+(\d+)\s*(?:s|sec|seconds?)?)?$/i
  );
  if (waitGoneMatch) {
    const text = stripTextPrefix(trimPunct(waitGoneMatch[2].trim()));
    const timeout = waitGoneMatch[1]
      ? Number(waitGoneMatch[1])
      : waitGoneMatch[3]
        ? Number(waitGoneMatch[3])
        : 10;
    if (text)
      return { kind: 'waitUntil', condition: 'gone', text, timeoutSeconds: timeout, verbatim };
  }

  // "wait" / "wait a moment" / "wait a bit" (no number) — default 2 seconds
  const waitBareMatch = t.match(
    /^(?:wait|sleep|pause)(?:\s+(?:a\s+)?(?:moment|bit|while|sec|second))?$/i
  );
  if (waitBareMatch) {
    return { kind: 'wait', seconds: 2, verbatim };
  }

  const waitMatch = t.match(
    /^(?:wait|sleep|pause)(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms|milliseconds)?$/i
  );
  if (waitMatch) {
    const n = Number(waitMatch[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = (waitMatch[2] ?? 's').toLowerCase();
    const seconds = unit.startsWith('m') ? n / 1000 : n;
    return { kind: 'wait', seconds, verbatim };
  }

  const backMatch = t.match(/^(?:go\s+)?back$|^navigate\s+back$|^press\s+back(?:\s+button)?$/i);
  if (backMatch) return { kind: 'back', verbatim };

  const homeMatch = t.match(
    /^(?:go\s+)?home$|^go\s+to\s+home(?:\s+screen)?$|^press\s+home(?:\s+button)?$/i
  );
  if (homeMatch) return { kind: 'home', verbatim };

  const enterMatch = t.match(
    /^(?:press\s+enter|hit\s+enter|send\s+enter|pe[r]?form\s+search|submit|submit\s+search|submit\s+form|search|confirm|hit\s+return|press\s+return)$/i
  );
  if (enterMatch) return { kind: 'enter', verbatim };

  const assertMatch =
    t.match(
      /^(?:assert|verify|check)\s+(?:that\s+|if\s+)?["']?(.+?)["']?\s+is\s+(?:visible|present|shown|displayed|on\s+(?:the\s+)?screen|in\s+(?:the\s+)?screen)$/i
    ) ??
    t.match(
      /^(?:assert|verify|check)\s+(?:that\s+|if\s+)?["']?(.+?)["']?\s+(?:visible|present|shown|displayed|on\s+(?:the\s+)?screen|in\s+(?:the\s+)?screen)$/i
    ) ??
    t.match(/^(?:assert|verify|check)\s+(?:that\s+|if\s+)?["']?(.+?)["']?$/i);
  if (assertMatch) {
    // Don't strip trailing punctuation for asserts — "!" may be part of the actual text
    const text = stripTextPrefix(assertMatch[1].trim());
    if (text) return { kind: 'assert', text, verbatim };
  }

  // "toggle X" / "enable X" / "disable X" / "turn on X" / "turn off X" — tap-style
  const toggleMatch = t.match(
    /^(?:toggle|enable|disable|turn\s+on|turn\s+off|switch\s+on|switch\s+off)\s+(?:the\s+)?(.+)$/i
  );
  if (toggleMatch) {
    const label = trimPunct(toggleMatch[1].trim());
    if (label) return { kind: 'tap', label, verbatim };
  }

  // "close X" / "dismiss X" / "cancel X" — tap-style
  const closeMatch = t.match(/^(?:close|dismiss|cancel)\s+(?:the\s+)?(.+)$/i);
  if (closeMatch) {
    const label = trimPunct(closeMatch[1].trim());
    if (label) return { kind: 'tap', label, verbatim };
  }

  const doneMatch = t.match(/^done(?:\s*[:\-]\s*|\s+)(.+)$/i);
  if (doneMatch) {
    return { kind: 'done', message: trimPunct(doneMatch[1].trim()), verbatim };
  }
  if (/^done\.?$/i.test(t)) {
    return { kind: 'done', verbatim };
  }

  return null;
}
