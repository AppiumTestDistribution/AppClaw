/**
 * Parse flow YAML: structured steps, natural-language lines, or both.
 *
 * Supports two YAML shapes:
 *
 * 1. **Flat** (legacy) — a list of steps:
 *    ```yaml
 *    platform: android
 *    ---
 *    - open Settings
 *    - tap WiFi
 *    - done
 *    ```
 *
 * 2. **Phased** — setup / steps / assertions sections:
 *    ```yaml
 *    name: login_test
 *    platform: android
 *    env: dev
 *    ---
 *    setup:
 *      - open MyApp
 *      - wait until login screen is visible
 *    steps:
 *      - type "${secrets.email}" in email field
 *      - type "${secrets.password}" in password field
 *      - tap Login
 *    assertions:
 *      - verify Dashboard is visible
 *      - assert Welcome is visible
 *    ```
 *
 * Variable interpolation (`${variables.X}`, `${secrets.X}`) is resolved
 * after parsing via the VariableResolver — the parser itself is pure structure.
 */

import { readFileSync } from 'fs';
import { parseAllDocuments } from 'yaml';

import type {
  FlowMeta,
  FlowStep,
  FlowPhase,
  PhasedStep,
  ParsedFlow,
  ParsedSuite,
} from './types.js';
import { tryParseNaturalFlowLine } from './natural-line.js';
import { resolveNaturalStep } from './llm-parser.js';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import {
  interpolateStep,
  emptyBindings,
  mergeBindings,
  loadEnvironmentFile,
  loadInlineBindings,
  type VariableBindings,
} from './variable-resolver.js';

// ── Step normalizer (unchanged logic, extracted for SRP) ───────────

export function normalizeStructured(raw: unknown, index: number): FlowStep | null {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === 'launchApp') return { kind: 'launchApp' };
    if (s === 'enter') return { kind: 'enter' };
    if (s === 'goBack' || s === 'back') return { kind: 'back' };
    if (s === 'goHome' || s === 'home') return { kind: 'home' };

    const nl = tryParseNaturalFlowLine(s);
    if (nl) return nl;

    // Not recognized — caller will use LLM
    return null;
  }

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const keys = Object.keys(o);

    // ── Multi-key: waitUntil with timeout ──
    if (keys.includes('waitUntil') || keys.includes('waitUntilGone')) {
      const isGone = keys.includes('waitUntilGone');
      const key = isGone ? 'waitUntilGone' : 'waitUntil';
      const val = String(o[key]).trim();
      const timeout = Number(o.timeout ?? 10);
      if (!Number.isFinite(timeout) || timeout < 1) {
        throw new Error(`Step ${index + 1}: waitUntil timeout must be a positive number`);
      }
      const valLower = val.toLowerCase();
      if (
        !isGone &&
        (valLower === 'screen loaded' ||
          valLower === 'screenloaded' ||
          valLower === 'screen ready' ||
          valLower === 'screen stable')
      ) {
        return { kind: 'waitUntil', condition: 'screenLoaded', timeoutSeconds: timeout };
      }
      return {
        kind: 'waitUntil',
        condition: isGone ? 'gone' : 'visible',
        text: val,
        timeoutSeconds: timeout,
      };
    }

    // ── Multi-key: drag { from, to } ──
    if (keys.includes('from') && keys.includes('to')) {
      const duration = o.duration != null ? Number(o.duration) : undefined;
      const longPressDuration =
        o.longPressDuration != null ? Number(o.longPressDuration) : undefined;
      return {
        kind: 'drag',
        from: String(o.from).trim(),
        to: String(o.to).trim(),
        ...(duration != null && { duration }),
        ...(longPressDuration != null && { longPressDuration }),
      };
    }

    // ── Multi-key: scrollAssert ──
    if (
      keys.includes('scrollAssert') ||
      keys.includes('scrollVerify') ||
      keys.includes('scrollCheck')
    ) {
      const textKey = keys.find(
        (k) => k === 'scrollAssert' || k === 'scrollVerify' || k === 'scrollCheck'
      )!;
      const text = String(o[textKey]);
      const dir = String(o.direction ?? 'down').toLowerCase();
      if (!['up', 'down', 'left', 'right'].includes(dir)) {
        throw new Error(
          `Step ${index + 1}: scrollAssert direction must be up/down/left/right, got "${dir}"`
        );
      }
      const maxScrolls = Number(o.maxScrolls ?? 3);
      if (!Number.isFinite(maxScrolls) || maxScrolls < 1) {
        throw new Error(`Step ${index + 1}: scrollAssert maxScrolls must be a positive number`);
      }
      return {
        kind: 'scrollAssert',
        text,
        direction: dir as 'up' | 'down' | 'left' | 'right',
        maxScrolls,
      };
    }

    if (keys.length !== 1) {
      throw new Error(
        `Step ${index + 1}: expected a single key per object (e.g. tap: "Label"), got: ${keys.join(', ')}`
      );
    }
    const k = keys[0];
    const v = o[k];

    if (k === 'wait') {
      const sec = Number(v);
      if (!Number.isFinite(sec) || sec < 0) {
        throw new Error(`Step ${index + 1}: wait must be a non-negative number (seconds)`);
      }
      return { kind: 'wait', seconds: sec };
    }
    if (k === 'waitUntil') {
      const val = String(v).trim().toLowerCase();
      if (
        val === 'screen loaded' ||
        val === 'screenloaded' ||
        val === 'screen ready' ||
        val === 'screen stable'
      ) {
        return { kind: 'waitUntil', condition: 'screenLoaded', timeoutSeconds: 10 };
      }
      return {
        kind: 'waitUntil',
        condition: 'visible',
        text: String(v).trim(),
        timeoutSeconds: 10,
      };
    }
    if (k === 'waitUntilGone') {
      return { kind: 'waitUntil', condition: 'gone', text: String(v).trim(), timeoutSeconds: 10 };
    }
    if (k === 'drag') {
      const val = String(v).trim();
      const toIdx = val.indexOf(' to ');
      if (toIdx !== -1) {
        return { kind: 'drag', from: val.slice(0, toIdx).trim(), to: val.slice(toIdx + 4).trim() };
      }
      throw new Error(
        `Step ${index + 1}: drag requires "from to to" syntax, e.g. drag: "green dot to +100 mark"`
      );
    }
    if (k === 'tap') return { kind: 'tap', label: String(v) };
    if (k === 'type') return { kind: 'type', text: String(v) };
    if (k === 'assert' || k === 'verify' || k === 'check') {
      return { kind: 'assert', text: String(v) };
    }
    if (k === 'getInfo') {
      return { kind: 'getInfo', query: String(v) };
    }
    if (k === 'done') {
      return { kind: 'done', message: v == null || v === '' ? undefined : String(v) };
    }
    throw new Error(`Step ${index + 1}: unknown action "${k}"`);
  }

  throw new Error(`Step ${index + 1}: invalid step (expected string or single-key object)`);
}

// ── Raw step parsing (with optional LLM fallback) ──────────────────

async function parseRawSteps(rawSteps: unknown[], strict?: boolean): Promise<FlowStep[]> {
  const steps: FlowStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const structured = normalizeStructured(rawSteps[i], i);
    if (structured) {
      steps.push(structured);
    } else {
      const instruction = String(rawSteps[i]).trim();
      if (strict) {
        throw new Error(
          `Step ${i + 1}: unrecognized instruction "${instruction}". ` +
            `Fix the YAML or remove --strict to allow LLM fallback.`
        );
      }
      const resolved = await resolveNaturalStep(instruction);
      steps.push(resolved.step);
    }
  }
  return steps;
}

// ── Phased extraction ──────────────────────────────────────────────

interface RawExtraction {
  meta: FlowMeta;
  /** Flat list — legacy format */
  rawSteps?: unknown[];
  /** Phased format */
  rawSetup?: unknown[];
  rawMain?: unknown[];
  rawAssertions?: unknown[];
}

const PHASE_KEYS = new Set(['setup', 'steps', 'assertions']);
const META_KEYS = new Set(['appId', 'name', 'description', 'platform', 'env', 'parallel']);

function extractRaw(docs: ReturnType<typeof parseAllDocuments>): RawExtraction {
  let meta: FlowMeta = {};

  // ── Two-document format ──
  if (docs.length >= 2) {
    const m = docs[0].toJS();
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const { env: envBlock, ...rest } = m as Record<string, unknown>;
      meta = rest as FlowMeta;
      if (envBlock && typeof envBlock === 'object') {
        meta.inlineEnv = envBlock as Record<string, unknown>;
      } else if (typeof envBlock === 'string') {
        meta.env = envBlock;
      }
    }

    const doc2 = docs[1].toJS();

    // doc2 is a plain array → flat format
    if (Array.isArray(doc2)) {
      return { meta, rawSteps: doc2 };
    }

    // doc2 is an object — could be phased or { steps: [...] }
    if (doc2 && typeof doc2 === 'object') {
      const obj = doc2 as Record<string, unknown>;
      return extractPhasedOrFlat(meta, obj);
    }

    return { meta, rawSteps: doc2 as unknown[] };
  }

  // ── Single-document format ──
  const j = docs[0].toJS();
  if (Array.isArray(j)) {
    return { meta, rawSteps: j };
  }
  if (j && typeof j === 'object') {
    const obj = j as Record<string, unknown>;
    // Pull meta keys out
    for (const key of META_KEYS) {
      if (key in obj) {
        if (key === 'env' && typeof obj[key] === 'object') {
          meta.inlineEnv = obj[key] as Record<string, unknown>;
        } else {
          (meta as Record<string, unknown>)[key] = obj[key];
        }
      }
    }
    return extractPhasedOrFlat(meta, obj);
  }

  throw new Error('Invalid flow YAML root');
}

function extractPhasedOrFlat(meta: FlowMeta, obj: Record<string, unknown>): RawExtraction {
  // Suite detection: object has a `flows:` key containing file paths
  if (Array.isArray(obj.flows) && obj.flows.every((f) => typeof f === 'string')) {
    // Handled upstream — caller checks for suite before calling this
    throw new Error('Suite YAML (flows: [...]) must be parsed with parseFlowOrSuiteFile');
  }

  const hasPhaseKeys = Object.keys(obj).some((k) => PHASE_KEYS.has(k));

  if (hasPhaseKeys) {
    // Phased format
    const rawSetup = Array.isArray(obj.setup) ? obj.setup : undefined;
    const rawMain = Array.isArray(obj.steps) ? obj.steps : undefined;
    const rawAssertions = Array.isArray(obj.assertions) ? obj.assertions : undefined;

    if (!rawMain && !rawSetup && !rawAssertions) {
      throw new Error('Phased flow must have at least one of: setup, steps, assertions');
    }

    return { meta, rawSetup, rawMain, rawAssertions };
  }

  // Flat with `steps` key
  if (Array.isArray(obj.steps)) {
    return { meta, rawSteps: obj.steps };
  }

  throw new Error(
    'Expected a YAML sequence of steps, or two documents (meta --- steps), ' +
      'or an object with `steps: []`, or phased sections (setup/steps/assertions)'
  );
}

// ── Public API ─────────────────────────────────────────────────────

export interface ParseOptions {
  /** Variable bindings to interpolate. If omitted, no interpolation. */
  bindings?: VariableBindings;
  /**
   * When true, throw an error instead of falling back to the LLM for
   * unrecognized steps. Use in --flow mode so bad YAML fails fast rather
   * than silently being fixed at runtime.
   */
  strict?: boolean;
}

export async function parseFlowYamlString(
  content: string,
  options: ParseOptions = {}
): Promise<ParsedFlow> {
  const docs = parseAllDocuments(content);
  if (docs.length === 0) {
    throw new Error('Empty YAML');
  }

  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new Error(doc.errors.map((e) => e.message).join('; '));
    }
  }

  const raw = extractRaw(docs);
  const bindings = options.bindings ?? emptyBindings();
  const { strict } = options;

  // ── Phased format ──
  if (raw.rawSetup || raw.rawMain || raw.rawAssertions) {
    const phases: PhasedStep[] = [];
    const allSteps: FlowStep[] = [];

    if (raw.rawSetup) {
      const setupSteps = await parseRawSteps(raw.rawSetup, strict);
      for (const s of setupSteps) {
        const resolved = interpolateStep(s as Record<string, unknown>, bindings) as FlowStep;
        phases.push({ step: resolved, phase: 'setup' });
        allSteps.push(resolved);
      }
    }

    if (raw.rawMain) {
      const mainSteps = await parseRawSteps(raw.rawMain, strict);
      for (const s of mainSteps) {
        const resolved = interpolateStep(s as Record<string, unknown>, bindings) as FlowStep;
        phases.push({ step: resolved, phase: 'test' });
        allSteps.push(resolved);
      }
    }

    if (raw.rawAssertions) {
      const assertSteps = await parseRawSteps(raw.rawAssertions, strict);
      for (const s of assertSteps) {
        const resolved = interpolateStep(s as Record<string, unknown>, bindings) as FlowStep;
        phases.push({ step: resolved, phase: 'assertion' });
        allSteps.push(resolved);
      }
    }

    return { meta: raw.meta, steps: allSteps, phases };
  }

  // ── Flat format (legacy) ──
  if (!raw.rawSteps || !Array.isArray(raw.rawSteps)) {
    throw new Error('Flow steps must be a YAML array');
  }

  const steps = await parseRawSteps(raw.rawSteps, strict);
  const resolvedSteps = steps.map(
    (s) => interpolateStep(s as Record<string, unknown>, bindings) as FlowStep
  );
  const phases: PhasedStep[] = resolvedSteps.map((step) => ({ step, phase: 'test' as FlowPhase }));

  return { meta: raw.meta, steps: resolvedSteps, phases };
}

/**
 * Parse a flow YAML file with automatic environment resolution.
 *
 * If the YAML meta contains `env: <name>`, the parser will look for
 * `.appclaw/env/<name>.yaml` relative to the flow file's directory
 * (walking up to find `.appclaw/`). Inline `env:` blocks are also supported.
 *
 * Explicit `options.bindings` take precedence over auto-resolved bindings
 * (e.g. when the user passes `--env` on the CLI).
 */
export async function parseFlowYamlFile(
  filepath: string,
  options: ParseOptions = {}
): Promise<ParsedFlow> {
  const content = readFileSync(filepath, 'utf-8');

  // If caller already provided bindings (e.g. --env CLI flag), use those directly
  if (options.bindings && Object.keys(options.bindings.variables).length > 0) {
    return parseFlowYamlString(content, options);
  }

  // First pass: extract meta to discover env: field (parse without bindings)
  const docs = parseAllDocuments(content);
  if (docs.length === 0) throw new Error('Empty YAML');
  const raw = extractRaw(docs);
  let bindings = emptyBindings();

  // Auto-resolve env: from YAML meta
  if (raw.meta.env) {
    const envFile = findEnvFile(filepath, raw.meta.env);
    if (envFile) {
      try {
        bindings = loadEnvironmentFile(envFile);
      } catch {
        // Non-fatal: log warning but continue without bindings
      }
    }
  }

  // Merge inline env block (lower priority than file-based)
  if (raw.meta.inlineEnv) {
    try {
      const inlineBindings = loadInlineBindings(raw.meta.inlineEnv);
      bindings = mergeBindings(inlineBindings, bindings); // file-based wins
    } catch {
      // Non-fatal
    }
  }

  return parseFlowYamlString(content, { bindings });
}

// ── Suite detection ────────────────────────────────────────────────

/** Returns true if the YAML content describes a suite (has top-level `flows:` list of strings). */
export function isSuiteYaml(content: string): boolean {
  try {
    const docs = parseAllDocuments(content);
    if (docs.length === 0) return false;
    // Two-doc: check second doc. Single-doc: check the only doc.
    const doc = docs.length >= 2 ? docs[1].toJS() : docs[0].toJS();
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const obj = doc as Record<string, unknown>;
      return Array.isArray(obj.flows) && obj.flows.every((f: unknown) => typeof f === 'string');
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Parse a suite YAML file — a YAML that lists other flow YAML files.
 *
 * Supported formats:
 * ```yaml
 * name: regression_suite
 * platform: android
 * parallel: 2
 * flows:
 *   - flows/login.yaml
 *   - flows/checkout.yaml
 * ```
 *
 * Or two-document style:
 * ```yaml
 * name: regression_suite
 * platform: android
 * parallel: 2
 * ---
 * flows:
 *   - flows/login.yaml
 *   - flows/checkout.yaml
 * ```
 *
 * Flow paths are resolved relative to the suite file's directory.
 */
export function parseSuiteYamlFile(filepath: string): ParsedSuite {
  const content = readFileSync(filepath, 'utf-8');
  const docs = parseAllDocuments(content);
  if (docs.length === 0) throw new Error('Empty suite YAML');

  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new Error(doc.errors.map((e) => e.message).join('; '));
    }
  }

  let meta: FlowMeta = {};
  let rawFlows: unknown[] | undefined;

  if (docs.length >= 2) {
    // Two-doc: first is meta, second has `flows:`
    const m = docs[0].toJS();
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      meta = m as FlowMeta;
    }
    const doc2 = docs[1].toJS();
    if (doc2 && typeof doc2 === 'object' && !Array.isArray(doc2)) {
      rawFlows = (doc2 as Record<string, unknown>).flows as unknown[];
    }
  } else {
    // Single doc: meta fields + flows in same object
    const doc = docs[0].toJS();
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const obj = doc as Record<string, unknown>;
      for (const key of META_KEYS) {
        if (key in obj) (meta as Record<string, unknown>)[key] = obj[key];
      }
      rawFlows = obj.flows as unknown[];
    }
  }

  if (!Array.isArray(rawFlows) || rawFlows.length === 0) {
    throw new Error('Suite YAML must have a non-empty `flows:` list of file paths');
  }
  if (!rawFlows.every((f) => typeof f === 'string')) {
    throw new Error('Suite `flows:` entries must all be file path strings');
  }

  const suiteDir = dirname(resolve(filepath));
  const flows = (rawFlows as string[]).map((f) => resolve(suiteDir, f));

  return { meta, flows };
}

/**
 * Walk up from the flow file directory to find `.appclaw/env/<name>.yaml`.
 * Returns the full path or null if not found.
 */
function findEnvFile(flowFilePath: string, envName: string): string | null {
  let dir = dirname(resolve(flowFilePath));
  const root = resolve('/');

  while (dir !== root) {
    const candidate = resolve(dir, '.appclaw', 'env', `${envName}.yaml`);
    if (existsSync(candidate)) return candidate;
    const ymlCandidate = resolve(dir, '.appclaw', 'env', `${envName}.yml`);
    if (existsSync(ymlCandidate)) return ymlCandidate;
    dir = dirname(dir);
  }

  return null;
}
