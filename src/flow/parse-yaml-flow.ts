/**
 * Parse flow YAML: structured steps, natural-language lines, or both.
 *
 * - Structured: `tap: "X"`, `wait: 2`, `launchApp`, etc.
 * - Natural language: `open my app`, `click on Login`, `swipe up`, `wait 2 s`
 *
 * Document 1: appId / name (optional)
 * ---
 * Document 2: list of steps
 */

import { readFileSync } from "fs";
import { parseAllDocuments } from "yaml";

import type { FlowMeta, FlowStep, ParsedFlow } from "./types.js";
import { tryParseNaturalFlowLine } from "./natural-line.js";

function normalizeStep(raw: unknown, index: number): FlowStep {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "launchApp") return { kind: "launchApp" };
    if (s === "enter") return { kind: "enter" };
    if (s === "goBack" || s === "back") return { kind: "back" };
    if (s === "goHome" || s === "home") return { kind: "home" };

    const nl = tryParseNaturalFlowLine(s);
    if (nl) return nl;

    throw new Error(
      `Step ${index + 1}: unknown step "${s}". ` +
        `Use structured steps (tap:, wait:, …) or natural language, e.g. "open My App", "click on Login", "swipe up".`
    );
  }

  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const keys = Object.keys(o);

    // ── Multi-key: scrollAssert ──
    // e.g. { scrollAssert: "TestMu AI", direction: "down", maxScrolls: 3 }
    if (keys.includes("scrollAssert") || keys.includes("scrollVerify") || keys.includes("scrollCheck")) {
      const textKey = keys.find(k => k === "scrollAssert" || k === "scrollVerify" || k === "scrollCheck")!;
      const text = String(o[textKey]);
      const dir = String(o.direction ?? "down").toLowerCase();
      if (!["up", "down", "left", "right"].includes(dir)) {
        throw new Error(`Step ${index + 1}: scrollAssert direction must be up/down/left/right, got "${dir}"`);
      }
      const maxScrolls = Number(o.maxScrolls ?? 3);
      if (!Number.isFinite(maxScrolls) || maxScrolls < 1) {
        throw new Error(`Step ${index + 1}: scrollAssert maxScrolls must be a positive number`);
      }
      return {
        kind: "scrollAssert",
        text,
        direction: dir as "up" | "down" | "left" | "right",
        maxScrolls,
      };
    }

    if (keys.length !== 1) {
      throw new Error(`Step ${index + 1}: expected a single key per object (e.g. tap: "Label"), got: ${keys.join(", ")}`);
    }
    const k = keys[0];
    const v = o[k];

    if (k === "wait") {
      const sec = Number(v);
      if (!Number.isFinite(sec) || sec < 0) {
        throw new Error(`Step ${index + 1}: wait must be a non-negative number (seconds)`);
      }
      return { kind: "wait", seconds: sec };
    }
    if (k === "tap") return { kind: "tap", label: String(v) };
    if (k === "type") return { kind: "type", text: String(v) };
    if (k === "assert" || k === "verify" || k === "check") {
      return { kind: "assert", text: String(v) };
    }
    if (k === "done") {
      return { kind: "done", message: v == null || v === "" ? undefined : String(v) };
    }
    throw new Error(`Step ${index + 1}: unknown action "${k}"`);
  }

  throw new Error(`Step ${index + 1}: invalid step (expected string or single-key object)`);
}

export function parseFlowYamlString(content: string): ParsedFlow {
  const docs = parseAllDocuments(content);
  if (docs.length === 0) {
    throw new Error("Empty YAML");
  }

  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new Error(doc.errors.map(e => e.message).join("; "));
    }
  }

  let meta: FlowMeta = {};
  let rawSteps: unknown[];

  if (docs.length >= 2) {
    const m = docs[0].toJS();
    if (m && typeof m === "object" && !Array.isArray(m)) {
      meta = m as FlowMeta;
    }
    rawSteps = docs[1].toJS() as unknown[];
  } else {
    const j = docs[0].toJS();
    if (Array.isArray(j)) {
      rawSteps = j;
    } else if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      if (Array.isArray(o.steps)) {
        const { steps, ...rest } = o;
        meta = rest as FlowMeta;
        rawSteps = steps as unknown[];
      } else {
        throw new Error(
          "Expected a YAML sequence of steps, or two documents (meta --- steps), or an object with `steps: []`"
        );
      }
    } else {
      throw new Error("Invalid flow YAML root");
    }
  }

  if (!Array.isArray(rawSteps)) {
    throw new Error("Flow steps must be a YAML array");
  }

  const steps = rawSteps.map((r, i) => normalizeStep(r, i));
  return { meta, steps };
}

export function parseFlowYamlFile(filepath: string): ParsedFlow {
  const content = readFileSync(filepath, "utf-8");
  return parseFlowYamlString(content);
}
