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

  // Lenient path: extract the first balanced JSON object/array substring.
  const starts: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{' || ch === '[') starts.push(i);
  }

  for (const start of starts) {
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];

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
        const candidate = cleaned.slice(start, i + 1);
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
const TAP_ACTIONS = new Set(['click', 'tap', 'touch', 'select', 'long press', 'longpress']);

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
    /^(?:wait\s+until|wait\s+for)\s+["']?(.+?)["']?(?:\s+(?:is\s+)?(?:visible|present|shown|displayed|there|appears?))?\.?$/i
  );
  if (waitUntilVisible) {
    const text = waitUntilVisible[1].trim();
    // Exclude bare "wait for Ns" (already handled above) and very short strings
    if (text && !/^\d+(?:\.\d+)?\s*(?:s|sec|seconds|ms)?$/i.test(text)) {
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

  // Swipe/scroll
  if (SWIPE_ACTIONS.has(actionName)) {
    const direction = actionName as 'up' | 'down' | 'left' | 'right';
    const step: FlowStep = { kind: 'swipe', direction, verbatim: instruction };
    await mcp.callTool('appium_scroll', { direction });
    return { step, result: { success: true, message: `Swiped ${direction}` } };
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

  // Verify/assert — pass the user's original instruction to the vision model
  if (ASSERT_ACTIONS.has(actionName)) {
    const step: FlowStep = { kind: 'assert', text: instruction, verbatim: instruction };
    const t2 = performance.now();
    const visResponse = await client.isElementVisible(imageBase64, instruction, true);
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

    if (!fromLocator?.coordinates || !toLocator?.coordinates) {
      const msg = !fromLocator?.coordinates
        ? `"${step.from}" is not visible on screen`
        : `"${step.to}" is not visible on screen`;
      return { step, result: { success: false, message: msg } };
    }

    const [fy, fx] = fromLocator.coordinates;
    const [ty, tx] = toLocator.coordinates;

    if (fy === 0 && fx === 0) {
      return {
        step,
        result: { success: false, message: `Drag failed: "${step.from}" is not visible on screen` },
      };
    }
    if (ty === 0 && tx === 0) {
      return {
        step,
        result: { success: false, message: `Drag failed: "${step.to}" is not visible on screen` },
      };
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
          ? `Dragged "${step.from}" to "${step.to}"`
          : `Drag failed: ${dragText.slice(0, 200)}`,
      },
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
