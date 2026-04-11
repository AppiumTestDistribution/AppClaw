/**
 * Execute a declarative YAML flow (structured and/or natural-language steps).
 * Uses DOM or vision depending on AGENT_MODE:
 * - dom (default): DOM text matching with optional vision fallback.
 * - vision (AGENT_MODE=vision + VISION_LOCATE_PROVIDER=stark): full vision mode,
 *   skips DOM entirely and uses screenshots + AI vision for all interactions.
 *
 * Steps that don't match any regex pattern are sent to the LLM for interpretation.
 */

import type { MCPClient } from '../mcp/types.js';
import { getPageSource } from '../mcp/tools.js';
import { activateAppWithFallback } from '../mcp/activate-app.js';
import { detectDeviceUdid, typeViaKeyboard, typeViaSetValue } from '../mcp/keyboard.js';
import { detectPlatform } from '../perception/screen.js';
import { parseAndroidPageSource } from '../perception/android-parser.js';
import { parseIOSPageSource } from '../perception/ios-parser.js';
import type { UIElement } from '../perception/types.js';
import {
  findByIdStrategies,
  findByVision,
  isAIElement,
  parseAIElementCoords,
  tapAtCoordinates,
} from '../agent/element-finder.js';
import {
  isVisionLocateEnabled,
  getStarkVisionApiKey,
  getStarkVisionBaseUrl,
  getStarkVisionCoordinateOrder,
  getStarkVisionModel,
} from '../vision/locate-enabled.js';
import { Config } from '../config.js';
import { screenshot } from '../mcp/tools.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ActionResult } from '../llm/schemas.js';

const execAsync = promisify(exec);
import type { FlowMeta, FlowStep, FlowPhase, PhasedStep, PhaseResult } from './types.js';
import type { AppResolver } from '../agent/app-resolver.js';
import type { RunArtifactCollector } from '../report/writer.js';
import { lastVisionScreenshot } from './vision-execute.js';
import { resolveAppId } from '../agent/preprocessor.js';
import { pngDimensionsFromBase64 } from '../vision/png-dimensions.js';
import { getCachedScreenSize, getScreenSizeForStark } from '../vision/window-size.js';
import chalk from 'chalk';
import * as ui from '../ui/terminal.js';

/** Extract [x, y] coordinates from an action result message like 'Tapped "X" via vision at [320, 540]' */
function extractCoordinates(message?: string): { x: number; y: number } | undefined {
  if (!message) return undefined;
  const m = message.match(/\[(\d+),\s*(\d+)\]/);
  if (m) return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunYamlFlowOptions {
  stepDelayMs?: number;
  /** Required for natural-language `open … app` steps */
  appResolver?: AppResolver;
  /**
   * When tapping by label, re-read the hierarchy this many times until a match appears
   * (covers navigation / animation). Default 20 × 300ms ≈ 6s max wait before vision / failure.
   */
  tapTargetMaxAttempts?: number;
  tapTargetPollIntervalMs?: number;
  /** Optional callback for each flow step execution (used by --json mode / IDE extensions) */
  onFlowStep?: (
    step: number,
    total: number,
    kind: string,
    target: string | undefined,
    status: 'running' | 'passed' | 'failed',
    error?: string,
    message?: string
  ) => void;
  /** Optional artifact collector for report generation. When set, screenshots are captured after each step. */
  artifactCollector?: RunArtifactCollector;
  /** Known device UDID from setup — avoids ADB re-detection (which fails when multiple devices are connected) */
  deviceUdid?: string;
}

const DEFAULT_TAP_MAX_ATTEMPTS = 20;
const DEFAULT_TAP_POLL_MS = 300;

export interface FlowTapPollOptions {
  maxAttempts: number;
  intervalMs: number;
}

export interface RunYamlFlowResult {
  success: boolean;
  stepsExecuted: number;
  stepsTotal: number;
  failedAt?: number;
  reason?: string;
  /** Per-phase breakdown (populated when using setup/steps/assertions). */
  phaseResults?: PhaseResult[];
  /** Which phase failed (if any). */
  failedPhase?: FlowPhase;
}

/** Build the actual (non-redacted) label showing resolved values — for debug logging only. */
function stepLabelResolved(step: FlowStep): string {
  switch (step.kind) {
    case 'type':
      return `type "${step.text}"${step.target ? ` in "${step.target}"` : ''}`;
    case 'assert':
      return `assert "${step.text}"`;
    case 'openApp':
      return `open "${step.query}"`;
    default:
      return '';
  }
}

function stepLabel(step: FlowStep): string {
  if (step.verbatim) return step.verbatim;
  switch (step.kind) {
    case 'launchApp':
      return 'launchApp';
    case 'openApp':
      return `open "${step.query}"`;
    case 'wait':
      return `wait ${step.seconds}s`;
    case 'waitUntil':
      if (step.condition === 'screenLoaded')
        return `wait until screen is loaded (${step.timeoutSeconds}s timeout)`;
      if (step.condition === 'gone')
        return `wait until "${step.text}" is gone (${step.timeoutSeconds}s timeout)`;
      return `wait until "${step.text}" is visible (${step.timeoutSeconds}s timeout)`;
    case 'tap':
      return `tap "${step.label}"`;
    case 'type':
      return `type "${step.text.length > 40 ? `${step.text.slice(0, 37)}…` : step.text}"`;
    case 'enter':
      return 'enter';
    case 'back':
      return 'goBack';
    case 'home':
      return 'goHome';
    case 'swipe':
      return `swipe ${step.direction}`;
    case 'drag':
      return `drag "${step.from}" to "${step.to}"`;
    case 'assert':
      return `assert "${step.text}"`;
    case 'scrollAssert':
      return `scroll ${step.direction} until "${step.text}"`;
    case 'getInfo':
      return `getInfo "${step.query.length > 50 ? `${step.query.slice(0, 47)}…` : step.query}"`;
    case 'done':
      return step.message ? `done (${step.message})` : 'done';
  }
}

function scoreTapMatch(el: UIElement, needle: string): number {
  if (el.enabled === false) return -1;
  const n = needle.toLowerCase();
  const text = el.text.toLowerCase();
  const hint = (el.hint ?? '').toLowerCase();
  const aid = el.accessibilityId.toLowerCase();
  const id = el.id.toLowerCase();

  const fields = [text, hint, aid, id];
  // Score 0: exact match
  for (const f of fields) {
    if (f === n) return 0;
  }
  // Score 1: needle is inside a field (e.g. needle="Login" in "Login button")
  for (const f of fields) {
    if (f.includes(n)) return 1;
  }
  // Score 2: field is inside needle (e.g. field="GOT IT" in needle="got it button")
  for (const f of fields) {
    if (f && n.includes(f)) return 2;
  }
  return -1;
}

/**
 * Press Enter/Return key — tries multiple strategies:
 * 1. appium_mobile_press_key with ENTER (works cross-platform)
 * 2. appium_execute_script with mobile: shell (Android keyevent 66)
 * 3. ADB keyevent fallback (Android only)
 */
async function pressEnterKey(mcp: MCPClient): Promise<ActionResult> {
  // Strategy 1: cross-platform via appium_mobile_press_key
  try {
    await mcp.callTool('appium_mobile_press_key', { key: 'ENTER' });
    return { success: true, message: 'Pressed Enter' };
  } catch {
    /* try next strategy */
  }

  // Strategy 2: mobile: shell via appium_execute_script (Android)
  try {
    await mcp.callTool('appium_execute_script', {
      script: 'mobile: shell',
      args: [{ command: 'input', args: ['keyevent', '66'] }],
    });
    return { success: true, message: 'Pressed Enter' };
  } catch {
    /* try next strategy */
  }

  // Strategy 3: ADB fallback (Android only)
  try {
    const udid = await detectDeviceUdid();
    const androidHome =
      process.env.ANDROID_HOME ||
      process.env.ANDROID_SDK_ROOT ||
      `${process.env.HOME}/Library/Android/sdk`;
    const adbPath = `${androidHome}/platform-tools/adb`;
    const deviceFlag = udid ? `-s ${udid}` : '';
    await execAsync(`${adbPath} ${deviceFlag} shell input keyevent 66`, { timeout: 5000 });
    return { success: true, message: 'Pressed Enter' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to press Enter: ${msg}` };
  }
}

/** Whether the flow should operate in full-vision mode (skip DOM). */
function isVisionMode(): boolean {
  return Config.AGENT_MODE === 'vision' && isVisionLocateEnabled();
}

/** Try to tap an element using vision locate. Returns null if vision can't find it. */
async function tryTapByVision(mcp: MCPClient, label: string): Promise<ActionResult | null> {
  const uuid = await findByVision(mcp, `UI element labeled or showing "${label}"`);
  if (!uuid) return null;

  if (isAIElement(uuid)) {
    const coords = parseAIElementCoords(uuid);
    if (coords) {
      const tapped = await tapAtCoordinates(mcp, coords.x, coords.y);
      if (tapped) {
        return {
          success: true,
          message: `Tapped "${label}" via vision at [${coords.x}, ${coords.y}]`,
        };
      }
    }
    return null;
  }

  await mcp.callTool('appium_click', { elementUUID: uuid });
  return { success: true, message: `Tapped "${label}" via vision` };
}

/** One DOM snapshot: find label and click. Returns null if no match / no UUID (caller may retry). */
/** Returns: ActionResult on success, "no_match" if label not in DOM, null if matched but UUID failed */
async function tryTapByLabelOnDom(
  mcp: MCPClient,
  label: string
): Promise<ActionResult | 'no_match' | null> {
  const pageSource = await getPageSource(mcp);
  const platform = detectPlatform(pageSource);
  const elements =
    platform === 'android' ? parseAndroidPageSource(pageSource) : parseIOSPageSource(pageSource);

  const scored = elements
    .map((el) => ({ el, s: scoreTapMatch(el, label) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => {
      if (a.s !== b.s) return a.s - b.s;
      if (a.el.clickable !== b.el.clickable) return a.el.clickable ? -1 : 1;
      return 0;
    });

  const pick = scored[0]?.el;
  if (!pick) return 'no_match';

  const uuid = await findByIdStrategies(mcp, pick.accessibilityId || pick.id, pick.text);
  if (!uuid) return null;

  await mcp.callTool('appium_click', { elementUUID: uuid });
  const coords = pick.center;
  return { success: true, message: `Tapped "${label}" at [${coords[0]}, ${coords[1]}]` };
}

async function tapByLabel(
  mcp: MCPClient,
  label: string,
  poll: FlowTapPollOptions
): Promise<ActionResult> {
  // ── Vision-first mode: skip DOM entirely ──
  if (isVisionMode()) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      const visionTap = await tryTapByVision(mcp, label);
      if (visionTap) return visionTap;
      if (attempt < 2) await sleep(poll.intervalMs);
    }
    return { success: false, message: `No matching element for "${label}" (vision mode)` };
  }

  // ── DOM mode: DOM-first with vision fallback ──
  // If the first attempt finds zero DOM matches, skip further polls and
  // fall through to vision immediately (the element isn't text-based).
  for (let attempt = 0; attempt < poll.maxAttempts; attempt++) {
    const domTap = await tryTapByLabelOnDom(mcp, label);
    if (domTap === 'no_match') break; // not in DOM at all — skip to vision
    if (domTap) return domTap;
    if (attempt + 1 < poll.maxAttempts) {
      await sleep(poll.intervalMs);
    }
  }

  if (isVisionLocateEnabled()) {
    ui.printAgentBullet(`"${label}" not found in page source, trying vision…`);
    const visionTap = await tryTapByVision(mcp, label);
    if (visionTap) return visionTap;
  }

  return { success: false, message: `No matching element for "${label}"` };
}

async function flowTypeText(
  mcp: MCPClient,
  text: string,
  target?: string,
  deviceUdid?: string
): Promise<ActionResult> {
  if (mcpDebug) ui.printAgentBullet(`[type] text="${text}", target=${target ?? '(none)'}`);
  // ── If a target field is specified, tap it first to focus ──
  if (target) {
    const tapResult = await tapByLabel(mcp, target, { maxAttempts: 10, intervalMs: 300 });
    if (!tapResult.success) {
      return { success: false, message: `Could not find target field "${target}" to type into` };
    }
    await sleep(Config.CLOUD_PROVIDER ? 1200 : 300); // Cloud needs longer to settle focus
  }

  // ── Vision mode: locate input field via vision, then type via keyboard ──
  if (isVisionMode()) {
    // If no target was specified, use vision to find and tap an input field
    if (!target) {
      const visionUuid = await findByVision(mcp, 'text input field, search box, or editable area');
      if (visionUuid) {
        if (isAIElement(visionUuid)) {
          const coords = parseAIElementCoords(visionUuid);
          if (coords) await tapAtCoordinates(mcp, coords.x, coords.y);
        } else {
          await mcp.callTool('appium_click', { elementUUID: visionUuid });
        }
      }
    }
    // Type via W3C Actions — works on local and cloud, Android and iOS
    const sv = await typeViaSetValue(mcp, text);
    if (sv.success) {
      const msg = target ? `Typed "${text}" in "${target}"` : `Typed "${text}"`;
      return { success: true, message: msg };
    }
    // Fallback 3: appium_set_value on a vision-located element (no-target case only)
    if (!target) {
      const visionUuid = await findByVision(mcp, 'text input field, search box, or editable area');
      if (visionUuid && !isAIElement(visionUuid)) {
        await mcp.callTool('appium_clear_element', { elementUUID: visionUuid }).catch(() => {});
        const setResult = await mcp.callTool('appium_set_value', { elementUUID: visionUuid, text });
        const setText =
          setResult.content
            ?.map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : ''))
            .join('') ?? '';
        if (!setText.toLowerCase().includes('error') && !setText.toLowerCase().includes('failed')) {
          return { success: true, message: `Typed "${text}" via vision` };
        }
      }
    }
    return { success: false, message: 'Could not type text in vision mode' };
  }

  // ── DOM mode ──
  const pageSource = await getPageSource(mcp);
  const platform = detectPlatform(pageSource);

  const elements =
    platform === 'android' ? parseAndroidPageSource(pageSource) : parseIOSPageSource(pageSource);
  const editable = elements.find((e) => e.editable && e.enabled !== false);
  if (!editable) {
    return { success: false, message: 'No editable field found for type' };
  }
  const uuid = await findByIdStrategies(
    mcp,
    editable.accessibilityId || editable.id,
    editable.text
  );
  if (!uuid) {
    return { success: false, message: 'Could not resolve editable element' };
  }
  await mcp.callTool('appium_click', { elementUUID: uuid });
  await mcp.callTool('appium_clear_element', { elementUUID: uuid }).catch(() => {});
  const setResult = await mcp.callTool('appium_set_value', {
    ...(Config.CLOUD_PROVIDER ? { w3cActions: true } : { elementUUID: uuid }),
    text,
  });
  const setText =
    setResult.content
      ?.map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : ''))
      .join('') ?? '';
  if (setText.toLowerCase().includes('error') || setText.toLowerCase().includes('failed')) {
    return { success: false, message: setText.slice(0, 200) };
  }
  return { success: true, message: `Typed "${text}"` };
}

/** Check DOM for text match across element fields. */
function domContainsText(elements: UIElement[], needle: string): boolean {
  const n = needle.toLowerCase();
  return elements.some((el) => {
    const fields = [el.text, el.hint ?? '', el.accessibilityId, el.id];
    return fields.some((f) => f.toLowerCase().includes(n));
  });
}

/** Find an element whose text/hint/id contains the given needle (case-insensitive). */
function findElement(elements: UIElement[], needle: string): UIElement | undefined {
  const n = needle.toLowerCase();
  return elements.find((el) => {
    const fields = [el.text, el.hint ?? '', el.accessibilityId, el.id];
    return fields.some((f) => f.toLowerCase().includes(n));
  });
}

type SpatialRelation = 'below' | 'above' | 'left of' | 'right of';

interface SpatialAssertion {
  subjectText: string;
  relation: SpatialRelation;
  anchorText: string;
}

/**
 * Try to parse a spatial/relational assertion like:
 *   "if the text Jest is below Jasmine"
 *   "the text Submit is above Cancel"
 *   "Login is right of Register"
 */
function parseSpatialAssertion(assertion: string): SpatialAssertion | null {
  // Patterns: "[if] [the text] <subject> is (below|above|left of|right of) [the text] <anchor>"
  const re =
    /^(?:if\s+)?(?:the\s+text\s+)?["']?(.+?)["']?\s+is\s+(below|above|left\s+of|right\s+of)\s+(?:the\s+text\s+)?["']?(.+?)["']?$/i;
  const match = assertion.match(re);
  if (!match) return null;

  const relation = match[2].toLowerCase().replace(/\s+/g, ' ') as SpatialRelation;
  return {
    subjectText: match[1].trim(),
    relation,
    anchorText: match[3].trim(),
  };
}

/**
 * Evaluate a spatial relationship between two elements and return
 * { satisfied, reason } with a human-readable explanation.
 */
function evaluateSpatialRelation(
  elements: UIElement[],
  spatial: SpatialAssertion
): { satisfied: boolean; reason: string } {
  const subject = findElement(elements, spatial.subjectText);
  const anchor = findElement(elements, spatial.anchorText);

  if (!subject && !anchor) {
    return {
      satisfied: false,
      reason: `Neither "${spatial.subjectText}" nor "${spatial.anchorText}" found on screen`,
    };
  }
  if (!subject) {
    return {
      satisfied: false,
      reason: `"${spatial.subjectText}" not found on screen`,
    };
  }
  if (!anchor) {
    return {
      satisfied: false,
      reason: `"${spatial.anchorText}" not found on screen`,
    };
  }

  const [sx, sy] = subject.center;
  const [ax, ay] = anchor.center;

  let satisfied = false;
  let actual = '';

  switch (spatial.relation) {
    case 'below':
      satisfied = sy > ay;
      actual = satisfied
        ? `"${spatial.subjectText}" is below "${spatial.anchorText}"`
        : `"${spatial.subjectText}" is actually above "${spatial.anchorText}", not below`;
      break;
    case 'above':
      satisfied = sy < ay;
      actual = satisfied
        ? `"${spatial.subjectText}" is above "${spatial.anchorText}"`
        : `"${spatial.subjectText}" is actually below "${spatial.anchorText}", not above`;
      break;
    case 'left of':
      satisfied = sx < ax;
      actual = satisfied
        ? `"${spatial.subjectText}" is left of "${spatial.anchorText}"`
        : `"${spatial.subjectText}" is actually right of "${spatial.anchorText}", not left`;
      break;
    case 'right of':
      satisfied = sx > ax;
      actual = satisfied
        ? `"${spatial.subjectText}" is right of "${spatial.anchorText}"`
        : `"${spatial.subjectText}" is actually left of "${spatial.anchorText}", not right`;
      break;
  }

  return { satisfied, reason: actual };
}

/** Parse current page source into elements. */
async function getScreenElements(mcp: MCPClient): Promise<UIElement[]> {
  const pageSource = await getPageSource(mcp);
  const platform = detectPlatform(pageSource);
  return platform === 'android'
    ? parseAndroidPageSource(pageSource)
    : parseIOSPageSource(pageSource);
}

const ASSERT_DOM_POLLS_BEFORE_VISION = 3;

/**
 * Vision-based assertion: take a screenshot and ask the LLM
 * "Is this visible on screen?" — returns a true yes/no answer.
 */
const mcpDebug = process.env.MCP_DEBUG === '1' || process.env.MCP_DEBUG === 'true';

async function visionAssert(mcp: MCPClient, text: string): Promise<boolean> {
  const apiKey = getStarkVisionApiKey();
  const baseUrl = getStarkVisionBaseUrl();
  if (!apiKey && !baseUrl) {
    if (mcpDebug)
      ui.printWarning(
        '[vision-assert] No API key or local server configured, skipping vision assert'
      );
    return false;
  }

  const { StarkVisionClient } = (await import('df-vision')).default;
  const client = new StarkVisionClient({
    apiKey: apiKey || 'local',
    model: getStarkVisionModel(),
    disableThinking: true,
    ...(baseUrl && { baseUrl }),
    ...(baseUrl && { coordinateOrder: getStarkVisionCoordinateOrder() }),
  });

  const query = `Is "${text}" visible or present on this screen?`;

  // Single attempt — callers (waitUntilCondition, assertTextVisible) handle retrying
  const maxAttempts = 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(500);

    if (mcpDebug)
      ui.printAgentBullet(
        `[vision-assert] Taking screenshot for: "${text}"${attempt > 0 ? ` (retry ${attempt})` : ''}`
      );
    const rawImage = await screenshot(mcp);
    if (!rawImage) {
      if (mcpDebug) ui.printWarning('[vision-assert] Failed to capture screenshot');
      continue;
    }
    const { downscaleForVision } = await import('./vision-execute.js');
    const imageBase64 = await downscaleForVision(rawImage);
    if (mcpDebug)
      ui.printAgentBullet(
        `[vision-assert] Screenshot captured (${Math.round(imageBase64.length / 1024)}KB)`
      );

    if (mcpDebug)
      ui.printAgentBullet(
        `[vision-assert] Asking LLM: is "${text}" visible? (model: ${getStarkVisionModel()})`
      );
    const visT0 = performance.now();
    const response = await client.isElementVisible(imageBase64, query, false);
    const visElapsed = Math.round(performance.now() - visT0);
    if (mcpDebug)
      ui.printAgentBullet(`[vision-assert] LLM response (${visElapsed}ms): ${response}`);

    // Parse structured JSON response first (e.g. { conditionSatisfied: true/false })
    // Strip markdown code fences if present (```json ... ```)
    let result = false;
    const jsonStr = response
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.conditionSatisfied === 'boolean') {
        result = parsed.conditionSatisfied;
      } else if (typeof parsed.visible === 'boolean') {
        result = parsed.visible;
      } else {
        const lower = jsonStr.toLowerCase();
        result = lower.includes('"conditionsatisfied": true') || lower.includes('"visible": true');
      }
    } catch {
      const lower = response.toLowerCase();
      result = /\btrue\b/.test(lower) && !/\bfalse\b/.test(lower);
    }

    if (result) {
      console.log(`  ${chalk.green('[vision-assert] Verdict: VISIBLE ✓')}`);
      return true;
    }

    // Only log NOT VISIBLE on final attempt
    if (attempt === maxAttempts - 1) {
      console.log(`  ${chalk.red('[vision-assert] Verdict: NOT VISIBLE ✗')}`);
    }
  }

  return false;
}

async function assertTextVisible(
  mcp: MCPClient,
  text: string,
  poll: FlowTapPollOptions
): Promise<ActionResult> {
  const visionFirst = isVisionMode();
  const useVision = isVisionLocateEnabled();
  let lastElements: UIElement[] = [];

  // ── Check for spatial/relational assertions (e.g. "Jest is below Jasmine") ──
  const spatial = parseSpatialAssertion(text);
  if (spatial) {
    // For spatial assertions, get elements and evaluate the relationship
    lastElements = await getScreenElements(mcp);
    const { satisfied, reason } = evaluateSpatialRelation(lastElements, spatial);
    if (satisfied) {
      return { success: true, message: `Assertion passed: ${reason}` };
    }
    return { success: false, message: `Assertion failed: ${reason}` };
  }

  // ── Standard text-visibility assertion ──
  if (visionFirst) {
    // ── Vision mode: screenshot + LLM yes/no verification ──
    const visible = await visionAssert(mcp, text);
    if (visible) {
      return { success: true, message: `Verified "${text}" is visible (via vision)` };
    }
    // Grab screen elements for the failure message
    try {
      lastElements = await getScreenElements(mcp);
    } catch {
      /* ignore */
    }
  } else {
    // ── DOM-first mode ──
    const domPolls = useVision ? ASSERT_DOM_POLLS_BEFORE_VISION : poll.maxAttempts;
    for (let attempt = 0; attempt < domPolls; attempt++) {
      lastElements = await getScreenElements(mcp);
      if (domContainsText(lastElements, text)) {
        return { success: true, message: `Verified "${text}" is visible` };
      }
      if (attempt + 1 < domPolls) await sleep(poll.intervalMs);
    }

    // Vision fallback in DOM mode
    if (useVision) {
      const visible = await visionAssert(mcp, text);
      if (visible) {
        return { success: true, message: `Verified "${text}" is visible (via vision)` };
      }
    }
  }

  // Build a summary of what's actually on screen
  const screenTexts = lastElements.map((el) => el.text).filter((t) => t.length > 0);
  const uniqueTexts = [...new Set(screenTexts)];
  const screenSummary =
    uniqueTexts.length > 0
      ? `\n    Screen contains: ${uniqueTexts.join(' | ')}`
      : '\n    Screen: (no text elements found)';

  return {
    success: false,
    message: `Assertion failed: "${text}" not found on screen${screenSummary}`,
  };
}

/**
 * Scroll in a direction, checking after each scroll whether `text` is visible.
 * Checks the current screen BEFORE the first scroll — if the target is already
 * visible, returns immediately without scrolling (avoids pushing it off screen).
 */
async function scrollUntilVisible(
  mcp: MCPClient,
  text: string,
  direction: 'up' | 'down' | 'left' | 'right',
  maxScrolls: number,
  poll: FlowTapPollOptions
): Promise<ActionResult> {
  const visionFirst = isVisionMode();
  const useVision = isVisionLocateEnabled();

  // Helper: check if text is currently visible on screen
  const isVisible = async (): Promise<boolean> => {
    if (visionFirst) {
      return visionAssert(mcp, text);
    }
    // DOM check first
    const elements = await getScreenElements(mcp);
    if (domContainsText(elements, text)) return true;
    // Vision fallback in DOM mode
    if (useVision) return visionAssert(mcp, text);
    return false;
  };

  // ── Pre-scroll check: target may already be on screen ──
  if (await isVisible()) {
    return {
      success: true,
      message: `"${text}" already visible on screen (no scroll needed)`,
    };
  }

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    await mcp.callTool('appium_scroll', { direction });
    await sleep(800);

    if (await isVisible()) {
      return {
        success: true,
        message: `Found "${text}" after ${scroll + 1} scroll(s) ${direction}`,
      };
    }
  }

  // Show what's on screen after exhausting all scrolls
  let screenSummary = '';
  try {
    const elements = await getScreenElements(mcp);
    const uniqueTexts = [...new Set(elements.map((el) => el.text).filter((t) => t.length > 0))];
    screenSummary =
      uniqueTexts.length > 0
        ? `\n    Screen contains: ${uniqueTexts.join(' | ')}`
        : '\n    Screen: (no text elements found)';
  } catch {
    /* ignore */
  }

  return {
    success: false,
    message: `"${text}" not found after ${maxScrolls} scroll(s) ${direction}${screenSummary}`,
  };
}

/**
 * Wait until a condition is met: element visible, element gone, or screen loaded (DOM stable).
 * Polls every 500ms up to the given timeout.
 */
async function waitUntilCondition(
  mcp: MCPClient,
  condition: 'visible' | 'gone' | 'screenLoaded',
  text: string | undefined,
  timeoutSeconds: number,
  poll: FlowTapPollOptions
): Promise<ActionResult> {
  const pollMs = 500;
  const deadline = Date.now() + timeoutSeconds * 1000;

  if (condition === 'screenLoaded') {
    // Wait until the screen has stabilized.
    // In vision mode: compare screenshot sizes (no DOM call).
    // In DOM mode: compare DOM lengths as a proxy for structural stability.
    // Either way: if the size stays within 2% for 2 consecutive polls, the screen is loaded.
    let prevLen = 0;
    let stableCount = 0;
    const stableThreshold = 2;
    const visionMode = isVisionMode();
    while (Date.now() < deadline) {
      let len: number;
      if (visionMode) {
        const img = await screenshot(mcp);
        len = img?.length ?? 0;
      } else {
        const pageSource = await getPageSource(mcp);
        len = pageSource.length;
      }
      const delta = prevLen > 0 ? Math.abs(len - prevLen) / prevLen : 1;
      if (prevLen > 0 && delta <= 0.02) {
        stableCount++;
        if (stableCount >= stableThreshold) {
          return {
            success: true,
            message: `Screen loaded (stable after ${stableCount + 1} checks)`,
          };
        }
      } else {
        stableCount = 0;
      }
      prevLen = len;
      await sleep(pollMs);
    }
    return { success: false, message: `Screen did not stabilize within ${timeoutSeconds}s` };
  }

  if (!text) {
    return { success: false, message: `waitUntil "${condition}" requires a text/element target` };
  }

  const useVision = isVisionLocateEnabled();
  const visionFirst = isVisionMode();

  while (Date.now() < deadline) {
    let found = false;

    if (visionFirst) {
      found = await visionAssert(mcp, text);
    } else {
      const elements = await getScreenElements(mcp);
      found = domContainsText(elements, text);
      if (!found && useVision) {
        found = await visionAssert(mcp, text);
      }
    }

    if (condition === 'visible' && found) {
      return { success: true, message: `"${text}" appeared on screen` };
    }
    if (condition === 'gone' && !found) {
      return { success: true, message: `"${text}" is no longer on screen` };
    }

    await sleep(pollMs);
  }

  if (condition === 'visible') {
    return { success: false, message: `"${text}" did not appear within ${timeoutSeconds}s` };
  }
  return { success: false, message: `"${text}" did not disappear within ${timeoutSeconds}s` };
}

export async function executeStep(
  mcp: MCPClient,
  step: FlowStep,
  meta: FlowMeta,
  appResolver: AppResolver | undefined,
  tapPoll: FlowTapPollOptions,
  deviceUdid?: string
): Promise<ActionResult> {
  // Vision mode: natural language steps (verbatim set) use visionExecute with the original
  // instruction — same path as the playground — for precise context-aware element location.
  // Explicit YAML steps (no verbatim) fall through to the normal DOM/vision-locate paths.
  if (
    isVisionMode() &&
    step.verbatim &&
    (step.kind === 'tap' || step.kind === 'type' || step.kind === 'assert')
  ) {
    const { visionExecute } = await import('./vision-execute.js');
    const vr = await visionExecute(mcp, step.verbatim, appResolver, deviceUdid);
    if (vr && vr.result.message !== '__needs_executeStep__') {
      return vr.result;
    }
    // null = no vision API key, or needs executeStep — fall through
  }

  switch (step.kind) {
    case 'launchApp': {
      const id = meta.appId?.trim();
      if (!id) {
        return { success: false, message: 'launchApp requires appId in the YAML header' };
      }
      const r = await activateAppWithFallback(mcp, id);
      return { success: r.success, message: r.message };
    }
    case 'openApp': {
      if (!appResolver) {
        return {
          success: false,
          message: 'open … app steps need the installed-apps list (internal: pass AppResolver)',
        };
      }
      const pkg = resolveAppId(step.query, appResolver);
      if (!pkg) {
        return {
          success: false,
          message: `Could not resolve app name "${step.query}" to a package (install it or add appId in YAML header + use launchApp)`,
        };
      }
      const r = await activateAppWithFallback(mcp, pkg);
      return {
        success: r.success,
        message: r.success ? `Launched ${step.query} (${pkg})` : r.message,
      };
    }
    case 'wait':
      await sleep(Math.round(step.seconds * 1000));
      return { success: true, message: `Waited ${step.seconds}s` };
    case 'waitUntil':
      return waitUntilCondition(mcp, step.condition, step.text, step.timeoutSeconds, tapPoll);
    case 'tap':
      return tapByLabel(mcp, step.label, tapPoll);
    case 'type':
      return flowTypeText(mcp, step.text, step.target, deviceUdid);
    case 'enter':
      return pressEnterKey(mcp);
    case 'back':
      await mcp.callTool('appium_mobile_press_key', { key: 'BACK' });
      return { success: true, message: 'Back' };
    case 'home':
      await mcp.callTool('appium_mobile_press_key', { key: 'HOME' });
      return { success: true, message: 'Home' };
    case 'swipe': {
      // appium_scroll only supports up/down; use appium_swipe for left/right
      const dir = step.direction;
      const count = step.repeat ?? 1;
      const toolName = dir === 'left' || dir === 'right' ? 'appium_swipe' : 'appium_scroll';
      let lastError = '';
      for (let i = 0; i < count; i++) {
        const result = await mcp.callTool(toolName, { direction: dir });
        const text =
          result.content
            ?.map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : ''))
            .join('') ?? '';
        const bad = text.toLowerCase().includes('error') || text.toLowerCase().includes('failed');
        if (bad) {
          lastError = text.slice(0, 200);
          return { success: false, message: lastError };
        }
        if (i < count - 1) await sleep(300);
      }
      return {
        success: true,
        message: count > 1 ? `Swiped ${dir} ${count} times` : `Swiped ${dir}`,
      };
    }
    case 'drag': {
      const dragApiKey = getStarkVisionApiKey();
      const dragBaseUrl = getStarkVisionBaseUrl();
      if (!dragApiKey && !dragBaseUrl) {
        return {
          success: false,
          message: 'drag step requires vision (GEMINI_API_KEY or STARK_VISION_BASE_URL)',
        };
      }
      const dragImage = await screenshot(mcp);
      if (!dragImage) {
        return { success: false, message: 'Failed to capture screenshot for drag' };
      }
      const { StarkVisionClient: DragClient, scaleCoordinates: scaleDragCoords } = (
        await import('df-vision')
      ).default;
      const dragClient = new DragClient({
        apiKey: dragApiKey || 'local',
        model: getStarkVisionModel(),
        disableThinking: true,
        ...(dragBaseUrl && { baseUrl: dragBaseUrl }),
        ...(dragBaseUrl && { coordinateOrder: getStarkVisionCoordinateOrder() }),
      });
      const dragScreenSize = await getScreenSizeForStark(mcp, dragImage);
      const dragInstruction = `drag ${step.from} to ${step.to}`;
      const rawDragResp = await dragClient.understandAndLocate(dragInstruction, dragImage);
      const cleanedDragText = rawDragResp.trim().replace(/(^```json|```$)/g, '');
      let dragActions: any[];
      try {
        const parsed = JSON.parse(cleanedDragText);
        dragActions = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return { success: false, message: 'Vision could not parse drag response' };
      }
      const dragAction = dragActions[0];
      if (!dragAction || dragAction.action !== 'drag' || (dragAction.locators?.length ?? 0) < 2) {
        const locCount = dragAction?.locators?.length ?? 0;
        let msg: string;
        if (!dragAction || dragAction.action !== 'drag') {
          msg = `"${step.from}" and "${step.to}" are not visible on screen`;
        } else if (locCount === 0) {
          msg = `"${step.from}" and "${step.to}" are not visible on screen`;
        } else {
          // One locator found — assume "from" was found, "to" is missing
          msg = `"${step.to}" is not visible on screen`;
        }
        return { success: false, message: msg };
      }
      const fromCoords = dragAction.locators[0].coordinates as [number, number] | undefined;
      const toCoords = dragAction.locators[1].coordinates as [number, number] | undefined;
      if (!fromCoords || !toCoords) {
        return { success: false, message: 'Drag: vision returned no coordinates' };
      }

      if (fromCoords[0] === 0 && fromCoords[1] === 0) {
        return { success: false, message: `Drag failed: "${step.from}" is not visible on screen` };
      }
      if (toCoords[0] === 0 && toCoords[1] === 0) {
        return { success: false, message: `Drag failed: "${step.to}" is not visible on screen` };
      }

      const fromBbox = scaleDragCoords(fromCoords, dragScreenSize);
      const toBbox = scaleDragCoords(toCoords, dragScreenSize);
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
        success: dragSuccess,
        message: dragSuccess
          ? `Dragged "${step.from}" to "${step.to}"`
          : `Drag failed: ${dragText.slice(0, 200)}`,
      };
    }
    case 'assert':
      return assertTextVisible(mcp, step.text, tapPoll);
    case 'scrollAssert':
      return scrollUntilVisible(mcp, step.text, step.direction, step.maxScrolls, tapPoll);
    case 'getInfo': {
      const infoApiKey = getStarkVisionApiKey();
      const infoBaseUrl = getStarkVisionBaseUrl();
      if (!infoApiKey && !infoBaseUrl) {
        return {
          success: false,
          message: 'getInfo requires vision (GEMINI_API_KEY or STARK_VISION_BASE_URL)',
        };
      }
      const infoImage = await screenshot(mcp);
      if (!infoImage) {
        return { success: false, message: 'Failed to capture screenshot for getInfo' };
      }
      const { StarkVisionClient: InfoClient } = (await import('df-vision')).default;
      const infoClient = new InfoClient({
        apiKey: infoApiKey || 'local',
        model: getStarkVisionModel(),
        disableThinking: true,
        ...(infoBaseUrl && { baseUrl: infoBaseUrl }),
        ...(infoBaseUrl && { coordinateOrder: getStarkVisionCoordinateOrder() }),
      });
      const infoResponse = await infoClient.getElementInfo(infoImage, step.query, true);
      try {
        const infoParsed = JSON.parse(infoResponse.replace(/(^```json\s*|```\s*$)/g, '').trim());
        const answer = infoParsed.answer || infoResponse;
        return { success: true, message: answer };
      } catch {
        return { success: true, message: infoResponse };
      }
    }
    case 'done': {
      // When done has a message, treat it as an assertion — verify the claim
      // is true on screen before declaring success. A bare `done` (no message)
      // passes unconditionally.
      if (step.message) {
        const verification = await assertTextVisible(mcp, step.message, tapPoll);
        if (!verification.success) {
          return {
            success: false,
            message: `done assertion failed: "${step.message}" not verified on screen`,
          };
        }
      }
      return { success: true, message: step.message ?? 'done' };
    }
  }
}

/**
 * Execute a single phase (setup / test / assertion) and return its result.
 * Extracted for SRP: the runner orchestrates phases, this handles one.
 */
async function executePhase(
  mcp: MCPClient,
  phase: FlowPhase,
  steps: FlowStep[],
  meta: FlowMeta,
  appResolver: AppResolver | undefined,
  tapPoll: FlowTapPollOptions,
  stepDelayMs: number,
  globalStepOffset: number,
  globalTotal: number,
  onFlowStep: RunYamlFlowOptions['onFlowStep'],
  artifactCollector?: RunArtifactCollector,
  deviceUdid?: string
): Promise<PhaseResult> {
  const phaseLabels: Record<FlowPhase, string> = {
    setup: 'Setup',
    test: 'Test',
    assertion: 'Assertions',
  };

  ui.printAgentBullet(`── ${phaseLabels[phase]} ──`);

  let executed = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = stepLabel(step);
    const globalN = globalStepOffset + i + 1;

    // Debug: show resolved value when secrets are redacted
    if (mcpDebug && step.verbatim?.includes('***')) {
      const resolved = stepLabelResolved(step);
      if (resolved) ui.printAgentBullet(`[debug] resolved → ${resolved}`);
    }

    const globalIdx = globalStepOffset + i;
    artifactCollector?.startStep(globalIdx);

    // Capture "before" screenshot for interactive steps (tap, type, swipe)
    // Skip in vision mode — visionExecute takes its own screenshot internally.
    const isInteractive = step.kind === 'tap' || step.kind === 'type' || step.kind === 'swipe';
    let beforeImg: string | null = null;
    let beforeDims: { width: number; height: number } | undefined;
    if (artifactCollector && isInteractive && !isVisionMode()) {
      try {
        beforeImg = await screenshot(mcp);
        if (beforeImg) beforeDims = pngDimensionsFromBase64(beforeImg) ?? undefined;
      } catch {
        /* non-critical */
      }
    }

    onFlowStep?.(globalN, globalTotal, step.kind, label, 'running');
    const result = await executeStep(mcp, step, meta, appResolver, tapPoll, deviceUdid);
    ui.printFlowStep(globalN, globalTotal, label, result.success);
    onFlowStep?.(
      globalN,
      globalTotal,
      step.kind,
      label,
      result.success ? 'passed' : 'failed',
      result.success ? undefined : result.message,
      result.message
    );

    // Capture screenshot and record step for report artifacts
    if (artifactCollector) {
      const tapCoords = extractCoordinates(result.message);
      // Add step first so attachScreenshot can find it
      artifactCollector.addStep({
        index: globalIdx,
        kind: step.kind,
        verbatim: step.verbatim,
        target: label,
        phase,
        status: result.success ? 'passed' : 'failed',
        error: result.success ? undefined : result.message,
        message: result.message,
        tapCoordinates: tapCoords,
        deviceScreenSize: getCachedScreenSize(mcp) ?? undefined,
      });
      // In vision mode, visionExecute already captured the pre-action screenshot.
      // - Tap actions: attach as "before" so the tap dot overlay is rendered.
      // - Other actions (type, assert, swipe): attach as "after" so the screenshot is shown.
      // In DOM mode, use the explicit before screenshot + take an "after" screenshot.
      const visionShot = lastVisionScreenshot;
      if (visionShot) {
        const dims = pngDimensionsFromBase64(visionShot) ?? undefined;
        if (tapCoords) {
          artifactCollector.attachBeforeScreenshot(globalIdx, visionShot, dims);
        } else {
          artifactCollector.attachScreenshot(globalIdx, visionShot, dims);
        }
      } else {
        if (beforeImg) {
          artifactCollector.attachBeforeScreenshot(globalIdx, beforeImg, beforeDims);
        }
        // Attach "after" screenshot (shows the result)
        try {
          const img = await screenshot(mcp);
          if (img) {
            const dims = pngDimensionsFromBase64(img) ?? undefined;
            artifactCollector.attachScreenshot(globalIdx, img, dims);
          }
        } catch {
          /* non-critical */
        }
      }
    }

    executed++;

    if (!result.success) {
      return {
        phase,
        success: false,
        stepsExecuted: executed,
        stepsTotal: steps.length,
        failedAt: i + 1,
        reason: result.message,
      };
    }

    if (step.kind === 'done') break;
    if (i < steps.length - 1) await sleep(stepDelayMs);
  }

  return {
    phase,
    success: true,
    stepsExecuted: executed,
    stepsTotal: steps.length,
  };
}

export async function runYamlFlow(
  mcp: MCPClient,
  meta: FlowMeta,
  inputSteps: FlowStep[],
  options: RunYamlFlowOptions = {},
  phases?: PhasedStep[]
): Promise<RunYamlFlowResult> {
  const stepDelayMs = options.stepDelayMs ?? 500;
  const appResolver = options.appResolver;
  const tapPoll: FlowTapPollOptions = {
    maxAttempts: options.tapTargetMaxAttempts ?? DEFAULT_TAP_MAX_ATTEMPTS,
    intervalMs: options.tapTargetPollIntervalMs ?? DEFAULT_TAP_POLL_MS,
  };

  const title = meta.name?.trim() || meta.appId || 'YAML flow';
  const isPhased = phases && phases.some((p) => p.phase !== 'test');

  // ── Phased execution (setup → steps → assertions) ──
  if (isPhased && phases) {
    const phaseOrder: FlowPhase[] = ['setup', 'test', 'assertion'];
    const grouped = new Map<FlowPhase, FlowStep[]>();
    for (const phase of phaseOrder) {
      grouped.set(phase, []);
    }
    for (const ps of phases) {
      grouped.get(ps.phase)!.push(ps.step);
    }

    // Auto-append done step to assertions (or test if no assertions)
    const assertionSteps = grouped.get('assertion')!;
    const testSteps = grouped.get('test')!;
    const lastPhaseSteps = assertionSteps.length > 0 ? assertionSteps : testSteps;
    const lastStep = lastPhaseSteps[lastPhaseSteps.length - 1];
    if (!lastStep || lastStep.kind !== 'done') {
      lastPhaseSteps.push({ kind: 'done' });
    }

    const totalSteps = phaseOrder.reduce((sum, p) => sum + (grouped.get(p)?.length ?? 0), 0);
    ui.printReplayGoal(title, totalSteps);
    if (meta.description) {
      ui.printAgentBullet(meta.description);
    }

    const phaseResults: PhaseResult[] = [];
    let globalOffset = 0;
    let totalExecuted = 0;

    for (const phase of phaseOrder) {
      const steps = grouped.get(phase)!;
      if (steps.length === 0) continue;

      const result = await executePhase(
        mcp,
        phase,
        steps,
        meta,
        appResolver,
        tapPoll,
        stepDelayMs,
        globalOffset,
        totalSteps,
        options.onFlowStep,
        options.artifactCollector,
        options.deviceUdid
      );
      phaseResults.push(result);
      totalExecuted += result.stepsExecuted;
      globalOffset += steps.length;

      if (!result.success) {
        ui.printReplayResult(totalExecuted - 1, totalSteps, 0);
        ui.printError(
          `Flow stopped during ${phase} phase at step ${result.failedAt}`,
          result.reason
        );
        return {
          success: false,
          stepsExecuted: totalExecuted,
          stepsTotal: totalSteps,
          failedAt: globalOffset - steps.length + (result.failedAt ?? 0),
          reason: result.reason,
          phaseResults,
          failedPhase: phase,
        };
      }
    }

    ui.printReplayResult(totalExecuted, totalSteps, 0);
    return {
      success: true,
      stepsExecuted: totalExecuted,
      stepsTotal: totalSteps,
      phaseResults,
    };
  }

  // ── Flat execution (legacy — all steps treated as "test") ──
  let steps = inputSteps;
  const lastStep = steps[steps.length - 1];
  if (!lastStep || lastStep.kind !== 'done') {
    steps = [...steps, { kind: 'done' }];
  }

  const total = steps.length;
  ui.printReplayGoal(title, total);

  let executed = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = stepLabel(step);
    const n = i + 1;

    if (mcpDebug && step.verbatim?.includes('***')) {
      const resolved = stepLabelResolved(step);
      if (resolved) ui.printAgentBullet(`[debug] resolved → ${resolved}`);
    }

    options.artifactCollector?.startStep(i);

    // Capture "before" screenshot for interactive steps (tap, type, swipe)
    // Skip in vision mode — visionExecute takes its own screenshot internally.
    const isInteractiveFlat = step.kind === 'tap' || step.kind === 'type' || step.kind === 'swipe';
    let beforeImgFlat: string | null = null;
    let beforeDimsFlat: { width: number; height: number } | undefined;
    if (options.artifactCollector && isInteractiveFlat && !isVisionMode()) {
      try {
        beforeImgFlat = await screenshot(mcp);
        if (beforeImgFlat) beforeDimsFlat = pngDimensionsFromBase64(beforeImgFlat) ?? undefined;
      } catch {
        /* non-critical */
      }
    }

    options.onFlowStep?.(n, total, step.kind, stepLabel(step), 'running');
    const result = await executeStep(mcp, step, meta, appResolver, tapPoll, options.deviceUdid);
    ui.printFlowStep(n, total, label, result.success);
    options.onFlowStep?.(
      n,
      total,
      step.kind,
      stepLabel(step),
      result.success ? 'passed' : 'failed',
      result.success ? undefined : result.message,
      result.message
    );

    // Capture screenshot and record step for report artifacts
    if (options.artifactCollector) {
      const tapCoords = extractCoordinates(result.message);
      // Add step first so attachScreenshot can find it
      options.artifactCollector.addStep({
        index: i,
        kind: step.kind,
        verbatim: step.verbatim,
        target: label,
        phase: 'test',
        status: result.success ? 'passed' : 'failed',
        error: result.success ? undefined : result.message,
        message: result.message,
        tapCoordinates: tapCoords,
        deviceScreenSize: getCachedScreenSize(mcp) ?? undefined,
      });
      // In vision mode, visionExecute already captured the pre-action screenshot.
      // - Tap actions: attach as "before" so the tap dot overlay is rendered.
      // - Other actions (type, assert, swipe): attach as "after" so the screenshot is shown.
      // In DOM mode, use the explicit before screenshot + take an "after" screenshot.
      const visionShotFlat = lastVisionScreenshot;
      if (visionShotFlat) {
        const dims = pngDimensionsFromBase64(visionShotFlat) ?? undefined;
        if (tapCoords) {
          options.artifactCollector.attachBeforeScreenshot(i, visionShotFlat, dims);
        } else {
          options.artifactCollector.attachScreenshot(i, visionShotFlat, dims);
        }
      } else {
        if (beforeImgFlat) {
          options.artifactCollector.attachBeforeScreenshot(i, beforeImgFlat, beforeDimsFlat);
        }
        // Attach "after" screenshot (shows the result)
        try {
          const img = await screenshot(mcp);
          if (img) {
            const dims = pngDimensionsFromBase64(img) ?? undefined;
            options.artifactCollector.attachScreenshot(i, img, dims);
          }
        } catch {
          /* non-critical */
        }
      }
    }

    executed++;

    if (!result.success) {
      ui.printReplayResult(executed - 1, total, 0);
      ui.printError(`Flow stopped at step ${n}`, result.message);
      return {
        success: false,
        stepsExecuted: executed,
        stepsTotal: total,
        failedAt: n,
        reason: result.message,
      };
    }

    if (step.kind === 'done') {
      ui.printReplayResult(executed, total, 0);
      return {
        success: true,
        stepsExecuted: executed,
        stepsTotal: total,
        reason: step.message,
      };
    }

    await sleep(stepDelayMs);
  }

  ui.printReplayResult(executed, total, 0);
  return {
    success: true,
    stepsExecuted: executed,
    stepsTotal: total,
  };
}
