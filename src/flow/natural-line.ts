/**
 * Parse a single natural-language flow line into a FlowStep (verbatim preserved for display).
 * Returns null if the line does not match any supported pattern — caller may error or fall through.
 */

import type { FlowStep } from "./types.js";

function trimPunct(s: string): string {
  return s.replace(/[.!?]+$/g, "").trim();
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
    if (query) return { kind: "openApp", query, verbatim };
  }

  const clickMatch = t.match(/^(?:click|tap)(?:\s+on)?\s+(.+)$/i);
  if (clickMatch) {
    const label = trimPunct(clickMatch[1].trim());
    if (label) return { kind: "tap", label, verbatim };
  }

  const pressMatch = t.match(/^press(?:\s+on)?\s+(?:the\s+)?(.+)$/i);
  if (pressMatch) {
    const label = trimPunct(pressMatch[1].trim());
    if (label) return { kind: "tap", label, verbatim };
  }

  const typeMatch = t.match(/^(?:type|enter\s+text|input)\s+["'](.+)["']$/i);
  if (typeMatch) {
    return { kind: "type", text: typeMatch[1], verbatim };
  }
  // "Enter X in the search bar" / "Enter X in the text field" / "Type X in ..."
  const typeInMatch = t.match(/^(?:type|enter|input)\s+["']?(.+?)["']?\s+(?:in|into)\s+(?:the\s+)?(?:search\s+bar|text\s*field|input\s*field|field|box|area).*$/i);
  if (typeInMatch) {
    const text = trimPunct(typeInMatch[1].trim());
    if (text) return { kind: "type", text, verbatim };
  }
  const typeBare = t.match(/^(?:type|input)\s+(.+)$/i);
  if (typeBare && !t.match(/^type\s*:/i)) {
    const text = trimPunct(typeBare[1].trim());
    if (text) return { kind: "type", text, verbatim };
  }

  const swipeMatch = t.match(/^swipe\s+(up|down|left|right)\b/i);
  if (swipeMatch) {
    const direction = swipeMatch[1].toLowerCase() as "up" | "down" | "left" | "right";
    return { kind: "swipe", direction, verbatim };
  }

  const scrollMatch = t.match(/^scroll\s+(up|down|left|right)\b/i);
  if (scrollMatch) {
    const direction = scrollMatch[1].toLowerCase() as "up" | "down" | "left" | "right";
    return { kind: "swipe", direction, verbatim };
  }

  const waitMatch = t.match(
    /^(?:wait|sleep|pause)(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms|milliseconds)?$/i
  );
  if (waitMatch) {
    const n = Number(waitMatch[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = (waitMatch[2] ?? "s").toLowerCase();
    const seconds = unit.startsWith("m") ? n / 1000 : n;
    return { kind: "wait", seconds, verbatim };
  }

  const backMatch = t.match(/^(?:go\s+)?back$/i);
  if (backMatch) return { kind: "back", verbatim };

  const homeMatch = t.match(/^(?:go\s+)?home$/i);
  if (homeMatch) return { kind: "home", verbatim };

  const enterMatch = t.match(/^(?:press\s+enter|hit\s+enter|send\s+enter|pe[r]?form\s+search|submit|submit\s+search|search)$/i);
  if (enterMatch) return { kind: "enter", verbatim };

  // scroll down until "X" is visible / scroll down 3 times to find "X"
  const scrollAssertMatch = t.match(
    /^scroll\s+(up|down|left|right)\s+(?:(\d+)\s+times?\s+)?(?:until|to\s+(?:find|see|check|verify))\s+["']?(.+?)["']?\s*(?:is\s+(?:visible|present|shown|displayed))?$/i
  );
  if (scrollAssertMatch) {
    const direction = scrollAssertMatch[1].toLowerCase() as "up" | "down" | "left" | "right";
    const maxScrolls = scrollAssertMatch[2] ? Number(scrollAssertMatch[2]) : 3;
    const text = trimPunct(scrollAssertMatch[3].trim());
    if (text) return { kind: "scrollAssert", text, direction, maxScrolls, verbatim };
  }

  const assertMatch = t.match(/^(?:assert|verify|check)\s+(?:that\s+)?["']?(.+?)["']?\s+is\s+(?:visible|present|shown|displayed)$/i)
    ?? t.match(/^(?:assert|verify|check)\s+(?:that\s+)?["']?(.+?)["']?$/i);
  if (assertMatch) {
    const text = trimPunct(assertMatch[1].trim());
    if (text) return { kind: "assert", text, verbatim };
  }

  const doneMatch = t.match(/^done(?:\s*[:\-]\s*|\s+)(.+)$/i);
  if (doneMatch) {
    return { kind: "done", message: trimPunct(doneMatch[1].trim()), verbatim };
  }
  if (/^done\.?$/i.test(t)) {
    return { kind: "done", verbatim };
  }

  return null;
}
