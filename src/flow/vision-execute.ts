/**
 * Hybrid single-call vision executor for the playground.
 *
 * In vision mode (AGENT_MODE=vision), takes a screenshot + raw instruction
 * and sends ONE LLM call to Stark Vision's `understandAndLocate()`.
 * The response contains both the action classification AND element coordinates.
 *
 * Pre-checks:
 *   - detectSimpleAction() catches scroll/back/home with zero LLM cost.
 *   - Simple patterns (open app, wait, done) are matched with lightweight regex.
 *   - getInfo (questions) are routed to getElementInfo() separately.
 *
 * Falls back to the two-call path (classifyInstruction → executeStep) when
 * vision mode is off or the instruction is non-visual (open app, wait, done).
 */

import starkVision from 'df-vision';
import { trackVisionTokenUsage } from '../vision/vision-token-tracker.js';
import type { MCPClient } from '../mcp/types.js';
import type { FlowStep } from './types.js';
import type { ActionResult } from '../llm/schemas.js';
import { screenshot } from '../mcp/tools.js';
import {
  getStarkVisionApiKey,
  getStarkVisionBaseUrl,
  getStarkVisionCoordinateOrder,
  getStarkVisionModel,
} from '../vision/locate-enabled.js';
import { getScreenSizeForStark } from '../vision/window-size.js';
import { tapAtCoordinates } from '../agent/element-finder.js';
import { detectDeviceUdid, typeViaKeyboard, typeViaSetValue } from '../mcp/keyboard.js';
import { Config } from '../config.js';
import sharp from 'sharp';
import { theme } from '../ui/terminal.js';

const mcpDebug = process.env.MCP_DEBUG === '1' || process.env.MCP_DEBUG === 'true';

/**
 * The raw (full-res) screenshot captured by the most recent visionExecute call.
 * Set before the action executes so callers can use it as the "before" screenshot
 * for artifact reporting (tap dot overlay). Cleared at the start of each call.
 */
export let lastVisionScreenshot: string | null = null;

/** Max edge for screenshots sent to Stark vision. 512px for faster Gemini processing. */
const VISION_MAX_EDGE_PX = 512;

/** Downscale screenshot for vision — outputs JPEG (not PNG) to avoid size inflation. */
export async function downscaleForVision(base64: string): Promise<string> {
  try {
    const input = Buffer.from(base64, 'base64');
    const meta = await sharp(input).metadata();
    // Skip if already small enough
    if ((meta.width ?? 0) <= VISION_MAX_EDGE_PX && (meta.height ?? 0) <= VISION_MAX_EDGE_PX) {
      return base64;
    }
    const resized = await sharp(input)
      .resize({
        width: VISION_MAX_EDGE_PX,
        height: VISION_MAX_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();
    return resized.toString('base64');
  } catch {
    return base64;
  }
}

function logTiming(label: string, elapsed: number): void {
  if (!mcpDebug) return;
  console.log(`        ${theme.dim('vision')} ${theme.info(label)} ${theme.dim(`${elapsed}ms`)}`);
}

const {
  StarkVisionClient,
  detectSimpleAction,
  scaleCoordinates,
  findSubstringWithBrackets,
  sanitizeOutput,
} = starkVision;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJsonLenient(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  // Fast path: valid JSON already.
  try {
    return JSON.parse(cleaned);
  } catch {
    /* continue */
  }

  // Repair: LLMs sometimes omit the closing quote on a JSON key name before ':',
  // emitting  "key:[value]  instead of  "key":[value]
  // The regex only fires at key positions (after '{' or ',') so it cannot corrupt
  // string values that happen to contain a colon.
  const repaired = cleaned.replace(/(?<=[{,]\s*)"([A-Za-z_][A-Za-z0-9_]*):/g, '"$1":');
  try {
    return JSON.parse(repaired);
  } catch {
    /* continue */
  }

  // Lenient path: extract the first balanced JSON object/array substring.
  // Build `starts` with string-context awareness so that '[' or '{' characters
  // inside string values are not mistaken for the start of a JSON structure.
  // (Without this, a malformed key like "key:[926,357] would cause the inner '[' to
  // be treated as a start, and [926,357] would be returned instead of the real object.)
  const starts: number[] = [];
  {
    let inStr = false;
    let esc = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{' || ch === '[') starts.push(i);
    }
  }

  for (const start of starts) {
    const open = repaired[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < repaired.length; i++) {
      const ch = repaired[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === open) depth++;
      if (ch === close) depth--;

      if (depth === 0) {
        const candidate = repaired.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          break; // this start token isn't a valid JSON root
        }
      }
    }
  }

  // Keep the original error surface area (callers decide what to log/show).
  throw new Error('JSON parse failed');
}

/**
 * Extract a proximity anchor from an instruction, e.g. "next to logout" → "logout".
 * Returns null if no proximity reference found.
 */
function extractProximityAnchor(instruction: string): string | null {
  const m = instruction.match(
    /\b(?:next to|near|beside|adjacent to|right of|left of)\s+([a-z0-9 _'-]+?)(?:\s*$|\s+(?:button|icon|tab|link|text|label|field))/i
  );
  return m ? m[1].trim() : null;
}

/**
 * Ask the vision model what element on screen is closest to the failed instruction.
 * Returns null on error or if no useful answer found.
 */
async function getClosestMatchFromVision(
  client: {
    getElementInfo: (img: string, instruction: string, withExplanation: boolean) => Promise<string>;
  },
  imageBase64: string,
  instruction: string
): Promise<string | null> {
  try {
    const raw = await client.getElementInfo(
      imageBase64,
      `What element visible on screen is most similar to what the user wanted: "${instruction}"? Reply with just the element name/label, nothing else.`,
      false
    );
    const cleaned = raw
      .trim()
      .replace(/(^```json\s*|```\s*$)/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    const answer: string = parsed?.answer || '';
    return answer.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if an anchor element is visible on screen using the vision model.
 * Returns true if visible, true on error (fail-open to avoid blocking valid taps).
 */
async function anchorVisibleInVision(
  client: { isElementVisible: (img: string, instruction: string) => Promise<string> },
  imageBase64: string,
  anchor: string
): Promise<boolean> {
  try {
    const raw = await client.isElementVisible(imageBase64, anchor);
    const cleaned = raw
      .trim()
      .replace(/(^```json\s*|```\s*$)/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    return parsed?.conditionSatisfied !== false;
  } catch {
    return true; // fail-open
  }
}

/** Actions from combinedInstructionPrompt that map to tap/click. */
const TAP_ACTIONS = new Set(['click', 'tap', 'touch', 'select']);

/** Actions that map to long press. */
const LONG_PRESS_ACTIONS = new Set(['long press', 'longpress', 'long-press', 'press and hold']);

/** Actions that map to type/enter text. */
const TYPE_ACTIONS = new Set(['enter', 'type', 'send', 'sendkeys', 'set', 'set value']);

/** Actions that map to scroll/swipe. */
const SWIPE_ACTIONS = new Set(['up', 'down', 'left', 'right']);

/** Actions that map to verify/assert. */
const ASSERT_ACTIONS = new Set(['verify', 'validate', 'check', 'wait']);

/** Non-visual instructions handled without screenshot. */
interface PreCheckResult {
  /** If set, this FlowStep can be executed directly without vision. */
  step?: FlowStep;
  /** If set, this is a getInfo query — needs screenshot + getElementInfo. */
  getInfoQuery?: string;
  /** If set, this is a visibility assert — needs screenshot + isElementVisible (skip understandAndLocate). */
  assertQuery?: string;
}

/**
 * Quick pre-check: catch instructions that don't need a vision call.
 * Returns null if the instruction needs the full vision pipeline.
 */
function preCheck(instruction: string): PreCheckResult | null {
  const t = instruction.trim();

  // 0. scrollAssert — "scroll down 2 times until X is visible" must be checked
  //    BEFORE detectSimpleAction, which would match it as a plain swipe.
  const scrollAssertMatch = t.match(
    /^scroll\s+(up|down|left|right)\s+(?:(\d+)\s+times?\s+)?(?:until|to\s+(?:find|see|check|verify))\s+["']?(.+?)["']?\s*(?:is\s+(?:visible|present|shown|displayed|seen|found|there))?$/i
  );
  if (scrollAssertMatch) {
    const direction = scrollAssertMatch[1].toLowerCase() as 'up' | 'down' | 'left' | 'right';
    const maxScrolls = scrollAssertMatch[2] ? Number(scrollAssertMatch[2]) : 3;
    const text = scrollAssertMatch[3]
      .replace(/[.!?]+$/g, '')
      .replace(/^(?:the\s+)?(?:text|element|label)\s+/i, '')
      .trim();
    if (text) {
      return {
        step: { kind: 'scrollAssert', text, direction, maxScrolls, verbatim: t },
      };
    }
  }

  // 1. detectSimpleAction — scroll/back/home (zero-cost regex from df-vision)
  const simple = detectSimpleAction(t);
  if (simple) {
    if (simple.action === 'back') return { step: { kind: 'back', verbatim: t } };
    if (simple.action === 'home') return { step: { kind: 'home', verbatim: t } };
    if (SWIPE_ACTIONS.has(simple.action)) {
      return {
        step: {
          kind: 'swipe',
          direction: simple.action as 'up' | 'down' | 'left' | 'right',
          verbatim: t,
        },
      };
    }
  }

  // 2. open/launch app
  const openMatch = t.match(
    /^(?:open|launch|start|go\s+to)\s+(?:the\s+)?(.+?)(?:\s+(?:app|application))?$/i
  );
  if (openMatch) {
    const query = openMatch[1].replace(/[.!?]+$/g, '').trim();
    if (query) return { step: { kind: 'openApp', query, verbatim: t } };
  }

  // 3. wait/pause/sleep (fixed duration)
  const waitMatch = t.match(
    /^(?:wait|sleep|pause)(?:\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms)?)?$/i
  );
  if (waitMatch) {
    const n = waitMatch[1] ? Number(waitMatch[1]) : 2;
    const unit = (waitMatch[2] ?? 's').toLowerCase();
    const seconds = unit.startsWith('m') ? n / 1000 : n;
    return { step: { kind: 'wait', seconds, verbatim: t } };
  }

  // 3b. waitUntil — "wait for X", "wait until X is visible/gone", "wait until screen is loaded"
  // Optional leading timeout: "wait 10s until X is visible"
  const timeoutPrefix = t.match(/^wait\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\s+until\s+/i);
  const timeoutSeconds = timeoutPrefix ? Number(timeoutPrefix[1]) : 15;
  const waitBody = timeoutPrefix ? t.slice(timeoutPrefix[0].length - 1) : t; // body after optional "wait Ns"

  if (
    /^wait\s+(?:\d+\s*s(?:ec(?:onds?)?)?\s+)?until\s+screen\s+(?:is\s+)?(?:loaded|ready|done|finished)$/i.test(
      t
    )
  ) {
    return { step: { kind: 'waitUntil', condition: 'screenLoaded', timeoutSeconds, verbatim: t } };
  }
  const waitUntilGone = waitBody.match(
    /^(?:wait\s+until|wait\s+for)\s+["']?(.+?)["']?\s+(?:is\s+)?(?:gone|hidden|dismissed|disappears?)\.?$/i
  );
  if (waitUntilGone) {
    const text = waitUntilGone[1].trim();
    return { step: { kind: 'waitUntil', condition: 'gone', text, timeoutSeconds, verbatim: t } };
  }
  const waitUntilVisible = waitBody.match(
    /^(?:wait\s+until|wait\s+for)\s+["']?(.+?)["']?(?:\s+(?:is\s+|to\s+be\s+)?(?:vis\w*|present|shown|displayed?|there|appears?))?\.?$/i
  );
  if (waitUntilVisible) {
    const text = waitUntilVisible[1].trim();
    // Exclude bare "wait for Ns" (already handled above) and very short strings
    if (text && !/^\d+(?:\.\d+)?\s*(?:s|sec|seconds|ms)?$/i.test(text)) {
      if (mcpDebug)
        console.log(
          `        ${theme.dim('preCheck')} ${theme.info('waitUntil visible')} extracted text=${theme.warn(`"${text}"`)} timeout=${theme.dim(`${timeoutSeconds}s`)} from ${theme.dim(`"${t}"`)}`
        );
      return {
        step: { kind: 'waitUntil', condition: 'visible', text, timeoutSeconds, verbatim: t },
      };
    }
  }

  // 4. done
  const doneMatch = t.match(/^done(?:\s*[:\-]\s*|\s+)(.+)$/i);
  if (doneMatch) {
    return {
      step: { kind: 'done', message: doneMatch[1].replace(/[.!?]+$/g, '').trim(), verbatim: t },
    };
  }
  if (/^done\.?$/i.test(t)) {
    return { step: { kind: 'done', verbatim: t } };
  }

  // 5. press enter / submit
  const enterMatch = t.match(
    /^(?:press\s+enter|hit\s+enter|send\s+enter|submit|submit\s+search|submit\s+form|search|confirm|hit\s+return|press\s+return)$/i
  );
  if (enterMatch) {
    return { step: { kind: 'enter', verbatim: t } };
  }

  // 5b. long press (natural language — route to longPress step kind)
  const longPressMatch = t.match(
    /^(?:long[\s-]press|long[\s-]tap|press\s+and\s+hold)(?:\s+on)?\s+(?:the\s+)?(.+?)(?:\s+for\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?))?$/i
  );
  if (longPressMatch) {
    const label = longPressMatch[1].replace(/[.!?]+$/g, '').trim();
    const durRaw = longPressMatch[2];
    const durUnit = longPressMatch[3] ?? 'ms';
    const duration = durRaw
      ? durUnit.startsWith('s')
        ? Math.round(Number(durRaw) * 1000)
        : Math.round(Number(durRaw))
      : undefined;
    if (label)
      return {
        step: { kind: 'longPress', label, ...(duration != null ? { duration } : {}), verbatim: t },
      };
  }

  // 6. Visibility assert — any instruction starting with an assert/verify verb,
  //    or "is X visible?" pattern. Pass the full instruction to the vision model
  //    as-is — let the LLM interpret what to check instead of brittle regex parsing.
  const ASSERT_VERB_RE = /^(?:verify|validate|check|assert|confirm|ensure)\s+/i;
  if (ASSERT_VERB_RE.test(t)) {
    return { assertQuery: instruction.trim() };
  }
  // "is X visible?" / "is X on screen?" pattern
  if (
    /^is\s+.+\s+(?:visible|present|shown|displayed|there|on\s+(?:the\s+)?screen)\s*\??/i.test(t)
  ) {
    return { assertQuery: instruction.trim() };
  }

  // 7. Questions about the screen → getInfo
  //    If the instruction ends with "?" and didn't match an assert verb above,
  //    or if it lacks any actionable verb, it's a question.
  if (t.endsWith('?')) {
    return { getInfoQuery: t };
  }

  // Not a pre-check match — needs full vision pipeline
  return null;
}

export interface VisionExecuteResult {
  /** The FlowStep that was identified (for recording). */
  step: FlowStep;
  /** The execution result. */
  result: ActionResult;
  /** True if this was a getInfo query (not recorded as step). */
  isGetInfo?: boolean;
  /** The answer for getInfo queries. */
  getInfoAnswer?: string;
  getInfoExplanation?: string;
  /**
   * How directly the user's instruction described the located element (1–10).
   * Comes from the LLM's matchScore in the combinedInstructionPrompt response.
   * Low score = instruction was vague/sloppy → playground should refine the YAML verbatim.
   * High score = instruction was intentional/accurate → keep as-is.
   */
  matchScore?: number;
  /** LLM-suggested closest visible element when the tap failed. */
  closestMatch?: string;
}

/**
 * Single-call vision executor.
 * Takes raw instruction → screenshot → one Gemini call → classify + locate → execute.
 *
 * Returns the step + execution result, or null if vision mode is not available
 * (caller should fall back to the two-call path).
 */
export async function visionExecute(
  mcp: MCPClient,
  instruction: string,
  appResolver?: { resolve?: (query: string) => string | null },
  deviceUdid?: string,
  options?: { minMatchScore?: number }
): Promise<VisionExecuteResult | null> {
  lastVisionScreenshot = null; // Clear before each call
  const apiKey = getStarkVisionApiKey();
  const baseUrl = getStarkVisionBaseUrl();
  const coordinateOrder = getStarkVisionCoordinateOrder();
  if (!apiKey && !baseUrl) return null; // No vision available

  // ── Pre-check: non-visual instructions ──
  const pre = preCheck(instruction);
  if (pre?.step) {
    // scrollAssert and waitUntil need executeStep for their polling/scroll logic
    if (pre.step.kind === 'scrollAssert' || pre.step.kind === 'waitUntil') {
      return { step: pre.step, result: { success: false, message: '__needs_executeStep__' } };
    }
    // Other pre-check steps — let caller fall through to classifyInstruction → executeStep
    return null;
  }
  if (pre?.getInfoQuery) {
    // getInfo — screenshot + getElementInfo (separate prompt, not combinedInstruction)
    const rawImage = await screenshot(mcp);
    const imageBase64 = rawImage ? await downscaleForVision(rawImage) : rawImage;
    if (!imageBase64) {
      return {
        step: { kind: 'getInfo', query: pre.getInfoQuery, verbatim: instruction },
        result: { success: false, message: 'Failed to capture screenshot' },
        isGetInfo: true,
      };
    }
    const client = new StarkVisionClient({
      apiKey: apiKey || 'local',
      model: getStarkVisionModel(),
      disableThinking: true,
      ...(baseUrl && { baseUrl }),
      ...(baseUrl && { coordinateOrder }),
      onTokenUsage: trackVisionTokenUsage,
    });
    const t0 = performance.now();
    const response = await client.getElementInfo(imageBase64, pre.getInfoQuery, true);
    logTiming('getElementInfo', Math.round(performance.now() - t0));
    let answer: string;
    let explanation: string | undefined;
    try {
      const parsed = JSON.parse(response.replace(/(^```json\s*|```\s*$)/g, '').trim());
      answer = parsed.answer || response;
      explanation = parsed.explanation;
    } catch {
      answer = response;
    }
    return {
      step: { kind: 'getInfo', query: pre.getInfoQuery, verbatim: instruction },
      result: { success: true, message: answer },
      isGetInfo: true,
      getInfoAnswer: answer,
      getInfoExplanation: explanation,
    };
  }
  if (pre?.assertQuery) {
    // Visibility assert — screenshot + isElementVisible (skip understandAndLocate).
    // Pass the user's full instruction to the vision model — let the LLM interpret
    // what to check instead of brittle text extraction.
    const rawImage = await screenshot(mcp);
    const imageBase64 = rawImage ? await downscaleForVision(rawImage) : rawImage;
    if (!imageBase64) {
      return {
        step: { kind: 'assert', text: pre.assertQuery, verbatim: instruction },
        result: { success: false, message: 'Failed to capture screenshot' },
      };
    }
    const client = new StarkVisionClient({
      apiKey: apiKey || 'local',
      model: getStarkVisionModel(),
      disableThinking: true,
      ...(baseUrl && { baseUrl }),
      ...(baseUrl && { coordinateOrder }),
      onTokenUsage: trackVisionTokenUsage,
    });
    const visQuery = pre.assertQuery;
    const t0 = performance.now();
    const visResponse = await client.isElementVisible(imageBase64, visQuery, true);
    logTiming('isElementVisible', Math.round(performance.now() - t0));
    let visible = false;
    try {
      const parsed = JSON.parse(
        visResponse
          .replace(/^```(?:json)?\s*\n?/i, '')
          .replace(/\n?```\s*$/i, '')
          .trim()
      );
      visible = parsed.conditionSatisfied === true;
    } catch {
      visible = /\btrue\b/i.test(visResponse) && !/\bfalse\b/i.test(visResponse);
    }
    return {
      step: { kind: 'assert', text: visQuery, verbatim: instruction },
      result: {
        success: visible,
        message: visible
          ? `Assertion passed (via vision)`
          : `Assertion failed: not verified on screen`,
      },
    };
  }

  // ── Single vision call: screenshot + understandAndLocate ──
  const rawScreenshot = await screenshot(mcp);
  if (!rawScreenshot) return null;
  lastVisionScreenshot = rawScreenshot; // Expose for artifact reporting (tap dot overlay)
  // Downscale for faster Gemini processing — coordinates are normalized 0-1000 so resolution doesn't matter
  const imageBase64 = await downscaleForVision(rawScreenshot);
  if (mcpDebug) {
    const rawKB = Math.round(rawScreenshot.length / 1024);
    const newKB = Math.round(imageBase64.length / 1024);
    console.log(
      `        ${theme.dim('vision')} ${theme.info('screenshot')} ${theme.dim(`${rawKB}KB → ${newKB}KB`)}`
    );
  }

  // Use raw screenshot for screen size detection (need actual device pixels for tap coordinates)
  const screenSize = await getScreenSizeForStark(mcp, rawScreenshot);
  const client = new StarkVisionClient({
    apiKey: apiKey || 'local',
    model: getStarkVisionModel(),
    disableThinking: true,
    ...(baseUrl && { baseUrl }),
    onTokenUsage: trackVisionTokenUsage,
  });

  const t0 = performance.now();
  const rawResponse = await client.understandAndLocate(instruction, imageBase64);
  logTiming('understandAndLocate', Math.round(performance.now() - t0));
  if (mcpDebug)
    console.log(
      `        ${theme.dim('vision')} ${theme.info('raw response:')} ${theme.dim(String(rawResponse).slice(0, 300))}`
    );
  if (!rawResponse) {
    return {
      step: { kind: 'tap', label: instruction, verbatim: instruction } as FlowStep,
      result: { success: false, message: 'Vision returned empty response' },
    };
  }
  const cleanedText = rawResponse.trim().replace(/(^```json|```$)/g, '');

  let actions: any[];
  try {
    const parsed = parseJsonLenient(cleanedText);
    actions = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    if (mcpDebug)
      console.log(
        `        ${theme.dim('vision')} ${theme.error('JSON parse failed:')} ${theme.dim(cleanedText.slice(0, 100))}`
      );
    // Return error — don't fall through to another 7s LLM call
    return {
      step: { kind: 'tap', label: instruction, verbatim: instruction } as FlowStep,
      result: {
        success: false,
        message: `Vision could not parse response: ${cleanedText.slice(0, 100)}`,
      },
    };
  }

  if (actions.length === 0) {
    // Empty array = instruction not actionable, might be a getInfo question
    const t1 = performance.now();
    const infoResponse = await client.getElementInfo(imageBase64, instruction, true);
    logTiming('getElementInfo (fallback)', Math.round(performance.now() - t1));
    let answer: string;
    let explanation: string | undefined;
    try {
      const parsed = JSON.parse(infoResponse.replace(/(^```json\s*|```\s*$)/g, '').trim());
      answer = parsed.answer || infoResponse;
      explanation = parsed.explanation;
    } catch {
      answer = infoResponse;
    }
    return {
      step: { kind: 'getInfo', query: instruction, verbatim: instruction },
      result: { success: true, message: answer },
      isGetInfo: true,
      getInfoAnswer: answer,
      getInfoExplanation: explanation,
    };
  }

  // ── Map Stark action → FlowStep + execute ──
  const action = actions[0];
  const actionName = (action.action ?? '').toLowerCase().trim();
  const value = action.value ?? null;
  const locators = action.locators ?? [];

  if (mcpDebug)
    console.log(
      `        ${theme.dim('vision')} ${theme.info('parsed:')} action=${theme.warn(actionName)} value=${theme.dim(String(value))} locators=${theme.dim(JSON.stringify(locators).slice(0, 200))}`
    );

  // Swipe/scroll — full-screen (action IS the direction word) but only if no element locators
  if (SWIPE_ACTIONS.has(actionName)) {
    const direction = actionName as 'up' | 'down' | 'left' | 'right';
    const firstLocator = locators[0];
    const firstCoords = firstLocator?.coordinates;
    const hasElementCoords =
      firstCoords && firstCoords.length >= 2 && !(firstCoords[0] === 0 && firstCoords[1] === 0);

    if (!hasElementCoords) {
      const step: FlowStep = { kind: 'swipe', direction, verbatim: instruction };
      const gestureAction = direction === 'left' || direction === 'right' ? 'swipe' : 'scroll';
      await mcp.callTool('appium_gesture', { action: gestureAction, direction });
      return { step, result: { success: true, message: `Swiped ${direction}` } };
    }
    // Has element coords — fall through to element-targeted swipe below
  }

  // Element-targeted swipe: vision returns action=direction + locators, or action="swipe" + locators
  // e.g. "swipe the font size slider to the right" → action:"swipe"|"right", locators[0]=slider
  if ((SWIPE_ACTIONS.has(actionName) || actionName === 'swipe') && locators.length > 0) {
    const elementLocator = locators[0];
    const coords = elementLocator?.coordinates;
    const hasElementCoords = coords && coords.length >= 2 && !(coords[0] === 0 && coords[1] === 0);

    // Resolve direction: action name itself (when vision returns direction as action), then value, then instruction text
    const valueStr = value ? String(value).toLowerCase().trim() : '';
    const direction = (
      SWIPE_ACTIONS.has(actionName)
        ? actionName
        : SWIPE_ACTIONS.has(valueStr)
          ? valueStr
          : /\bright\b/.test(instruction.toLowerCase())
            ? 'right'
            : /\bleft\b/.test(instruction.toLowerCase())
              ? 'left'
              : /\bdown\b/.test(instruction.toLowerCase())
                ? 'down'
                : /\bup\b/.test(instruction.toLowerCase())
                  ? 'up'
                  : null
    ) as 'up' | 'down' | 'left' | 'right' | null;

    if (direction && hasElementCoords) {
      const [ey, ex] = coords!;
      const DRAG_OFFSET = 200;
      const dy = direction === 'down' ? DRAG_OFFSET : direction === 'up' ? -DRAG_OFFSET : 0;
      const dx = direction === 'right' ? DRAG_OFFSET : direction === 'left' ? -DRAG_OFFSET : 0;
      const ty = Math.max(0, Math.min(1000, ey + dy));
      const tx = Math.max(0, Math.min(1000, ex + dx));
      const step: FlowStep = { kind: 'swipe', direction, verbatim: instruction };
      const fromBbox = scaleCoordinates([ey, ex], screenSize);
      const toBbox = scaleCoordinates([ty, tx], screenSize);
      const dragResult = await mcp.callTool('appium_drag_and_drop', {
        sourceX: Math.round(fromBbox.center.x),
        sourceY: Math.round(fromBbox.center.y),
        targetX: Math.round(toBbox.center.x),
        targetY: Math.round(toBbox.center.y),
        duration: 600,
        longPressDuration: 400,
      });
      const dragText =
        dragResult.content?.map((c: any) => (c.type === 'text' ? c.text : '')).join('') ?? '';
      const dragSuccess =
        !dragText.toLowerCase().includes('failed') && !dragText.toLowerCase().includes('error');
      return {
        step,
        result: {
          success: dragSuccess,
          message: dragSuccess
            ? `Swiped "${elementLocator.element}" ${direction}`
            : `Swipe failed: ${dragText.slice(0, 200)}`,
        },
      };
    }

    // Direction or coords missing — fall through to tap handler below
  }

  // Back
  if (actionName === 'back') {
    const step: FlowStep = { kind: 'back', verbatim: instruction };
    await mcp.callTool('appium_mobile_press_key', { key: 'BACK' });
    return { step, result: { success: true, message: 'Back' } };
  }

  // Home
  if (actionName === 'home') {
    const step: FlowStep = { kind: 'home', verbatim: instruction };
    await mcp.callTool('appium_mobile_press_key', { key: 'HOME' });
    return { step, result: { success: true, message: 'Home' } };
  }

  // Launch app — return the step so caller can execute via executeStep without re-classifying
  if (actionName === 'launch' || actionName === 'launch app' || actionName === 'open app') {
    const step: FlowStep = { kind: 'openApp', query: value || instruction, verbatim: instruction };
    return { step, result: { success: false, message: '__needs_executeStep__' } };
  }

  // Verify/assert — use the extracted value (element name) from understandAndLocate,
  // not the raw instruction which may contain action words like "wait unil X is visible".
  if (ASSERT_ACTIONS.has(actionName)) {
    const assertTarget =
      value && typeof value === 'string' && value.trim() ? value.trim() : instruction;
    const step: FlowStep = { kind: 'assert', text: assertTarget, verbatim: instruction };
    const t2 = performance.now();
    const visResponse = await client.isElementVisible(imageBase64, assertTarget, true);
    logTiming('isElementVisible', Math.round(performance.now() - t2));
    let visible = false;
    const visJsonStr = visResponse
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
    try {
      const parsed = JSON.parse(visJsonStr);
      visible = parsed.conditionSatisfied === true;
    } catch {
      visible = /\btrue\b/i.test(visResponse) && !/\bfalse\b/i.test(visResponse);
    }
    return {
      step,
      result: {
        success: visible,
        message: visible
          ? `Assertion passed (via vision)`
          : `Assertion failed: not verified on screen`,
      },
    };
  }

  // Type/enter text
  if (TYPE_ACTIONS.has(actionName) && value) {
    const target = locators[0]?.element;
    const step: FlowStep = { kind: 'type', text: value, target, verbatim: instruction };

    // If locator has coordinates, tap to focus first
    const coords = locators[0]?.coordinates;
    if (coords && coords.length >= 2 && !(coords[0] === 0 && coords[1] === 0)) {
      const bbox = scaleCoordinates(coords as [number, number], screenSize);
      await tapAtCoordinates(mcp, bbox.center.x, bbox.center.y);
      // Cloud devices need longer for focus/keyboard to settle than local.
      await sleep(Config.CLOUD_PROVIDER ? 1200 : 600);
    }

    // Type via W3C Actions — works on local and cloud, Android and iOS
    for (let attempt = 0; attempt < 3; attempt++) {
      const sv = await typeViaSetValue(mcp, value);
      if (sv.success) {
        return {
          step,
          result: {
            success: true,
            message: `Typed "${value}"${target ? ` in "${target}"` : ''}`,
          },
        };
      }
      if (attempt < 2) await sleep(500);
    }

    // Local only: fall back to executeStep → flowTypeText (ADB + DOM). Cloud sessions have no
    // local ADB (placeholder UDID) and a second vision/DOM pass could double-tap — keep explicit failure.
    if (!Config.CLOUD_PROVIDER) {
      return { step, result: { success: false, message: '__needs_executeStep__' } };
    }
    return { step, result: { success: false, message: 'Could not type text' } };
  }

  // Drag
  if (actionName === 'drag') {
    const fromLocator = locators[0];
    const toLocator = locators[1];
    const step: FlowStep = {
      kind: 'drag',
      from: fromLocator?.element || instruction,
      to: toLocator?.element || '',
      verbatim: instruction,
    };

    if (!fromLocator?.coordinates) {
      return {
        step,
        result: { success: false, message: `"${step.from}" is not visible on screen` },
      };
    }

    const [fy, fx] = fromLocator.coordinates;
    if (fy === 0 && fx === 0) {
      return {
        step,
        result: { success: false, message: `Drag failed: "${step.from}" is not visible on screen` },
      };
    }

    // Determine destination coordinates.
    // When the vision model returns a directional drag (slider/seekbar), the destination
    // locator is either missing, empty, or just a direction word ("right", "left") with
    // zero/null coordinates. In that case, compute the destination from the source +
    // a normalized offset derived from the direction keyword in the instruction or to-element.
    let ty: number, tx: number;
    const hasValidToCoords =
      toLocator?.coordinates &&
      toLocator.coordinates.length >= 2 &&
      !(toLocator.coordinates[0] === 0 && toLocator.coordinates[1] === 0);

    if (hasValidToCoords) {
      [ty, tx] = toLocator!.coordinates;
    } else {
      // Try to infer direction from destination element name, then fall back to full instruction.
      // Stark coordinates are [y, x] in 0-1000 normalized space.
      const directionSource = `${toLocator?.element ?? ''} ${instruction}`.toLowerCase();
      const DRAG_OFFSET = 200; // ~20% of screen — enough to move a slider visibly
      let dy = 0,
        dx = 0;
      if (/\bright\b/.test(directionSource)) dx = DRAG_OFFSET;
      else if (/\bleft\b/.test(directionSource)) dx = -DRAG_OFFSET;
      else if (/\bdown\b/.test(directionSource)) dy = DRAG_OFFSET;
      else if (/\bup\b/.test(directionSource)) dy = -DRAG_OFFSET;
      else {
        return {
          step,
          result: {
            success: false,
            message: `"${step.to || 'destination'}" is not visible on screen`,
          },
        };
      }
      ty = Math.max(0, Math.min(1000, fy + dy));
      tx = Math.max(0, Math.min(1000, fx + dx));
    }

    const fromBbox = scaleCoordinates([fy, fx], screenSize);
    const toBbox = scaleCoordinates([ty, tx], screenSize);
    const dragResult = await mcp.callTool('appium_drag_and_drop', {
      sourceX: Math.round(fromBbox.center.x),
      sourceY: Math.round(fromBbox.center.y),
      targetX: Math.round(toBbox.center.x),
      targetY: Math.round(toBbox.center.y),
      duration: step.duration ?? 600,
      longPressDuration: step.longPressDuration ?? 400,
    });
    const dragText =
      dragResult.content?.map((c: any) => (c.type === 'text' ? c.text : '')).join('') ?? '';
    const dragSuccess =
      !dragText.toLowerCase().includes('failed') && !dragText.toLowerCase().includes('error');
    return {
      step,
      result: {
        success: dragSuccess,
        message: dragSuccess
          ? `Dragged "${step.from}" ${step.to ? `to "${step.to}"` : `(directional)`}`
          : `Drag failed: ${dragText.slice(0, 200)}`,
      },
    };
  }

  // Long press — LLM classified this as "long press"
  if (LONG_PRESS_ACTIONS.has(actionName)) {
    const label = locators[0]?.element || instruction;
    const step: FlowStep = { kind: 'longPress', label, verbatim: instruction };
    return {
      step,
      result: { success: true, message: '__needs_executeStep__' },
    };
  }

  // Tap/click (default for most actions)
  if (TAP_ACTIONS.has(actionName) || locators.length > 0) {
    const label = locators[0]?.element || instruction;
    const matchScore: number | undefined = locators[0]?.matchScore;
    const step: FlowStep = { kind: 'tap', label, verbatim: instruction };

    // Reject loose matches before touching the device
    if (
      options?.minMatchScore !== undefined &&
      matchScore !== undefined &&
      matchScore < options.minMatchScore
    ) {
      return {
        step,
        result: { success: false, message: `Element not found for "${instruction}".` },
        matchScore,
      };
    }

    // Verify proximity anchor is visible on screen before tapping
    const proximityAnchor = extractProximityAnchor(instruction);
    if (proximityAnchor) {
      const anchorExists = await anchorVisibleInVision(client, imageBase64, proximityAnchor);
      if (!anchorExists) {
        return {
          step,
          result: {
            success: false,
            message: `Element not found for "${instruction}". Anchor "${proximityAnchor}" is not visible on screen.`,
          },
          matchScore,
        };
      }
    }

    // Try coordinates from first locator
    for (const locator of locators) {
      const coords = locator.coordinates;
      if (coords && coords.length >= 2 && !(coords[0] === 0 && coords[1] === 0)) {
        const bbox = scaleCoordinates(coords as [number, number], screenSize);
        const { x, y } = bbox.center;
        const tapped = await tapAtCoordinates(mcp, x, y);
        if (tapped) {
          return {
            step,
            result: {
              success: true,
              message: `Tapped "${label}" at [${Math.round(x)}, ${Math.round(y)}]`,
            },
            matchScore,
          };
        }
      }

      // Fallback: getBoundingBox for the element
      if (locator.element) {
        const t3 = performance.now();
        const bboxResponse = await client.getBoundingBox(locator.element, imageBase64);
        logTiming('getBoundingBox', Math.round(performance.now() - t3));
        const arrayStr = findSubstringWithBrackets(bboxResponse);
        if (arrayStr) {
          const bboxCoords = sanitizeOutput(arrayStr) as [number, number];
          if (!(bboxCoords[0] === 0 && bboxCoords[1] === 0)) {
            const bbox = scaleCoordinates(bboxCoords, screenSize);
            const { x, y } = bbox.center;
            const tapped = await tapAtCoordinates(mcp, x, y);
            if (tapped) {
              return {
                step,
                result: {
                  success: true,
                  message: `Tapped "${label}" at [${Math.round(x)}, ${Math.round(y)}] (bbox)`,
                },
                matchScore,
              };
            }
          }
        }
      }
    }

    const closestMatch = await getClosestMatchFromVision(client, imageBase64, instruction);
    return {
      step,
      result: { success: false, message: `Could not locate "${label}" on screen` },
      matchScore,
      closestMatch: closestMatch ?? undefined,
    };
  }

  // Unknown action — don't fall through to another slow LLM call
  if (mcpDebug)
    console.log(
      `        ${theme.dim('vision')} ${theme.warn(`unknown action: "${actionName}"`)} ${theme.dim(JSON.stringify(action).slice(0, 120))}`
    );
  return {
    step: { kind: 'tap', label: instruction, verbatim: instruction } as FlowStep,
    result: {
      success: false,
      message: `Vision returned unrecognized action "${actionName}" for "${instruction}"`,
    },
  };
}
