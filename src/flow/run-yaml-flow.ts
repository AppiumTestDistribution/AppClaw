/**
 * Execute a declarative YAML flow (structured and/or natural-language steps).
 * No LLM required. Uses DOM or vision depending on AGENT_MODE:
 * - dom (default): DOM text matching with optional vision fallback.
 * - vision (AGENT_MODE=vision + VISION_LOCATE_PROVIDER=stark): full vision mode,
 *   skips DOM entirely and uses screenshots + AI vision for all interactions.
 */

import type { MCPClient } from "../mcp/types.js";
import { getPageSource } from "../mcp/tools.js";
import { activateAppWithFallback } from "../mcp/activate-app.js";
import { detectDeviceUdid, typeViaKeyboard } from "../mcp/keyboard.js";
import { detectPlatform } from "../perception/screen.js";
import { parseAndroidPageSource } from "../perception/android-parser.js";
import { parseIOSPageSource } from "../perception/ios-parser.js";
import type { UIElement } from "../perception/types.js";
import {
  findByIdStrategies,
  findByVision,
  isAIElement,
  parseAIElementCoords,
  tapAtCoordinates,
} from "../agent/element-finder.js";
import { isVisionLocateEnabled, getStarkVisionApiKey, getStarkVisionModel } from "../vision/locate-enabled.js";
import { Config } from "../config.js";
import { screenshot } from "../mcp/tools.js";
import { exec } from "child_process";
import { promisify } from "util";
import type { ActionResult } from "../llm/schemas.js";

const execAsync = promisify(exec);
import type { FlowMeta, FlowStep } from "./types.js";
import type { AppResolver } from "../agent/app-resolver.js";
import { resolveAppId } from "../agent/preprocessor.js";
import chalk from "chalk";
import * as ui from "../ui/terminal.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
}

function stepLabel(step: FlowStep): string {
  if (step.verbatim) return step.verbatim;
  switch (step.kind) {
    case "launchApp":
      return "launchApp";
    case "openApp":
      return `open "${step.query}"`;
    case "wait":
      return `wait ${step.seconds}s`;
    case "tap":
      return `tap "${step.label}"`;
    case "type":
      return `type "${step.text.length > 40 ? `${step.text.slice(0, 37)}…` : step.text}"`;
    case "enter":
      return "enter";
    case "back":
      return "goBack";
    case "home":
      return "goHome";
    case "swipe":
      return `swipe ${step.direction}`;
    case "assert":
      return `assert "${step.text}"`;
    case "scrollAssert":
      return `scroll ${step.direction} until "${step.text}"`;
    case "done":
      return step.message ? `done (${step.message})` : "done";
  }
}

function scoreTapMatch(el: UIElement, needle: string): number {
  if (el.enabled === false) return -1;
  const n = needle.toLowerCase();
  const text = el.text.toLowerCase();
  const hint = (el.hint ?? "").toLowerCase();
  const aid = el.accessibilityId.toLowerCase();
  const id = el.id.toLowerCase();

  const fields = [text, hint, aid, id];
  for (const f of fields) {
    if (f === n) return 0;
  }
  for (const f of fields) {
    if (f.includes(n)) return 1;
  }
  return -1;
}

/**
 * Press Enter/Return key — tries multiple strategies:
 * 1. appium_execute_script with mobile: shell (Android keyevent 66)
 * 2. ADB keyevent fallback
 */
async function pressEnterKey(mcp: MCPClient): Promise<ActionResult> {
  // Strategy 1: mobile: shell via appium_execute_script (Android)
  try {
    await mcp.callTool("appium_execute_script", {
      script: "mobile: shell",
      args: [{ command: "input", args: ["keyevent", "66"] }],
    });
    return { success: true, message: "Pressed Enter" };
  } catch { /* try next strategy */ }

  // Strategy 2: ADB fallback
  try {
    const udid = await detectDeviceUdid();
    const androidHome =
      process.env.ANDROID_HOME ||
      process.env.ANDROID_SDK_ROOT ||
      `${process.env.HOME}/Library/Android/sdk`;
    const adbPath = `${androidHome}/platform-tools/adb`;
    const deviceFlag = udid ? `-s ${udid}` : "";
    await execAsync(`${adbPath} ${deviceFlag} shell input keyevent 66`, { timeout: 5000 });
    return { success: true, message: "Pressed Enter" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to press Enter: ${msg}` };
  }
}

/** Whether the flow should operate in full-vision mode (skip DOM). */
function isVisionMode(): boolean {
  return Config.AGENT_MODE === "vision" && isVisionLocateEnabled();
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

  await mcp.callTool("appium_click", { elementUUID: uuid });
  return { success: true, message: `Tapped "${label}" via vision` };
}

/** One DOM snapshot: find label and click. Returns null if no match / no UUID (caller may retry). */
async function tryTapByLabelOnDom(mcp: MCPClient, label: string): Promise<ActionResult | null> {
  const pageSource = await getPageSource(mcp);
  const platform = detectPlatform(pageSource);
  const elements =
    platform === "android" ? parseAndroidPageSource(pageSource) : parseIOSPageSource(pageSource);

  const scored = elements
    .map(el => ({ el, s: scoreTapMatch(el, label) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => {
      if (a.s !== b.s) return a.s - b.s;
      if (a.el.clickable !== b.el.clickable) return a.el.clickable ? -1 : 1;
      return 0;
    });

  const pick = scored[0]?.el;
  if (!pick) return null;

  const uuid = await findByIdStrategies(mcp, pick.accessibilityId || pick.id, pick.text);
  if (!uuid) return null;

  await mcp.callTool("appium_click", { elementUUID: uuid });
  return { success: true, message: `Tapped "${label}"` };
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
  for (let attempt = 0; attempt < poll.maxAttempts; attempt++) {
    const domTap = await tryTapByLabelOnDom(mcp, label);
    if (domTap) return domTap;
    if (attempt + 1 < poll.maxAttempts) {
      await sleep(poll.intervalMs);
    }
  }

  if (isVisionLocateEnabled()) {
    const visionTap = await tryTapByVision(mcp, label);
    if (visionTap) return visionTap;
  }

  return { success: false, message: `No matching element for "${label}"` };
}

async function flowTypeText(mcp: MCPClient, text: string): Promise<ActionResult> {
  // ── Vision mode: locate input field via vision, then type via keyboard ──
  if (isVisionMode()) {
    // Try vision to find and tap the input field
    const visionUuid = await findByVision(mcp, "text input field, search box, or editable area");
    if (visionUuid) {
      if (isAIElement(visionUuid)) {
        const coords = parseAIElementCoords(visionUuid);
        if (coords) await tapAtCoordinates(mcp, coords.x, coords.y);
      } else {
        await mcp.callTool("appium_click", { elementUUID: visionUuid });
      }
    }
    // Type via keyboard (preferred on Android)
    const udid = await detectDeviceUdid();
    if (udid) {
      const kb = await typeViaKeyboard(text, udid);
      if (kb.success) return { success: true, message: kb.message };
    }
    // Fallback: try set_value on the vision-located element if it's a real UUID
    if (visionUuid && !isAIElement(visionUuid)) {
      await mcp.callTool("appium_clear_element", { elementUUID: visionUuid }).catch(() => {});
      const setResult = await mcp.callTool("appium_set_value", { elementUUID: visionUuid, text });
      const setText =
        setResult.content?.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : "")).join("") ?? "";
      if (!setText.toLowerCase().includes("error") && !setText.toLowerCase().includes("failed")) {
        return { success: true, message: `Typed "${text}" via vision` };
      }
    }
    return { success: false, message: "Could not type text in vision mode" };
  }

  // ── DOM mode ──
  const pageSource = await getPageSource(mcp);
  const platform = detectPlatform(pageSource);

  if (platform === "android") {
    const udid = await detectDeviceUdid();
    const kb = await typeViaKeyboard(text, udid ?? undefined);
    if (kb.success) {
      return { success: true, message: kb.message };
    }
  }

  const elements =
    platform === "android" ? parseAndroidPageSource(pageSource) : parseIOSPageSource(pageSource);
  const editable = elements.find(e => e.editable && e.enabled !== false);
  if (!editable) {
    return { success: false, message: "No editable field found for type" };
  }
  const uuid = await findByIdStrategies(mcp, editable.accessibilityId || editable.id, editable.text);
  if (!uuid) {
    return { success: false, message: "Could not resolve editable element" };
  }
  await mcp.callTool("appium_click", { elementUUID: uuid });
  await mcp.callTool("appium_clear_element", { elementUUID: uuid }).catch(() => {});
  const setResult = await mcp.callTool("appium_set_value", { elementUUID: uuid, text });
  const setText =
    setResult.content?.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : "")).join("") ??
    "";
  if (setText.toLowerCase().includes("error") || setText.toLowerCase().includes("failed")) {
    return { success: false, message: setText.slice(0, 200) };
  }
  return { success: true, message: `Typed "${text}"` };
}

/** Check DOM for text match across element fields. */
function domContainsText(elements: UIElement[], needle: string): boolean {
  const n = needle.toLowerCase();
  return elements.some(el => {
    const fields = [el.text, el.hint ?? "", el.accessibilityId, el.id];
    return fields.some(f => f.toLowerCase().includes(n));
  });
}

/** Parse current page source into elements. */
async function getScreenElements(mcp: MCPClient): Promise<UIElement[]> {
  const pageSource = await getPageSource(mcp);
  const platform = detectPlatform(pageSource);
  return platform === "android"
    ? parseAndroidPageSource(pageSource)
    : parseIOSPageSource(pageSource);
}

const ASSERT_DOM_POLLS_BEFORE_VISION = 3;

/**
 * Vision-based assertion: take a screenshot and ask the LLM
 * "Is this visible on screen?" — returns a true yes/no answer.
 */
const mcpDebug = process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true";

async function visionAssert(mcp: MCPClient, text: string): Promise<boolean> {
  const apiKey = getStarkVisionApiKey();
  if (!apiKey) {
    if (mcpDebug) ui.printWarning("[vision-assert] No API key configured, skipping vision assert");
    return false;
  }

  if (mcpDebug) ui.printAgentBullet(`[vision-assert] Taking screenshot for: "${text}"`);
  const imageBase64 = await screenshot(mcp);
  if (!imageBase64) {
    if (mcpDebug) ui.printWarning("[vision-assert] Failed to capture screenshot");
    return false;
  }
  if (mcpDebug) ui.printAgentBullet(`[vision-assert] Screenshot captured (${Math.round(imageBase64.length / 1024)}KB)`);

  const { StarkVisionClient } = (await import("df-vision")).default;
  const client = new StarkVisionClient({
    apiKey,
    model: getStarkVisionModel(),
  });

  if (mcpDebug) ui.printAgentBullet(`[vision-assert] Asking LLM: is "${text}" visible? (model: ${getStarkVisionModel()})`);
  const response = await client.isElementVisible(imageBase64, text, true);
  if (mcpDebug) ui.printAgentBullet(`[vision-assert] LLM response: ${response}`);

  // Parse structured JSON response first (e.g. { conditionSatisfied: true/false })
  let result = false;
  try {
    const parsed = JSON.parse(response);
    if (typeof parsed.conditionSatisfied === "boolean") {
      result = parsed.conditionSatisfied;
    } else if (typeof parsed.visible === "boolean") {
      result = parsed.visible;
    } else {
      // Fallback to text matching on the raw response
      const lower = response.toLowerCase();
      result = lower.includes('"conditionsatisfied": true') || lower.includes('"visible": true');
    }
  } catch {
    // Not JSON — fall back to simple text matching (avoid matching words in explanations)
    const lower = response.toLowerCase();
    result = /\btrue\b/.test(lower) && !/\bfalse\b/.test(lower);
  }

  const verdictMsg = result
    ? chalk.green("[vision-assert] Verdict: VISIBLE ✓")
    : chalk.red("[vision-assert] Verdict: NOT VISIBLE ✗");
  console.log(`  ${verdictMsg}`);
  return result;
}

async function assertTextVisible(
  mcp: MCPClient,
  text: string,
  poll: FlowTapPollOptions
): Promise<ActionResult> {
  const visionFirst = isVisionMode();
  const useVision = isVisionLocateEnabled();

  if (visionFirst) {
    // ── Vision mode: screenshot + LLM yes/no verification ──
    const visible = await visionAssert(mcp, text);
    if (visible) {
      return { success: true, message: `Verified "${text}" is visible (via vision)` };
    }
  } else {
    // ── DOM-first mode ──
    const domPolls = useVision ? ASSERT_DOM_POLLS_BEFORE_VISION : poll.maxAttempts;
    for (let attempt = 0; attempt < domPolls; attempt++) {
      const elements = await getScreenElements(mcp);
      if (domContainsText(elements, text)) {
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

  return { success: false, message: `Assertion failed: "${text}" not found on screen` };
}

/**
 * Scroll in a direction, checking after each scroll whether `text` is visible.
 * Unlike assertTextVisible, this always scrolls first before checking — it does
 * NOT check the current screen before the first scroll.
 */
async function scrollUntilVisible(
  mcp: MCPClient,
  text: string,
  direction: "up" | "down" | "left" | "right",
  maxScrolls: number,
  poll: FlowTapPollOptions
): Promise<ActionResult> {
  const visionFirst = isVisionMode();
  const useVision = isVisionLocateEnabled();

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    // Scroll first
    await mcp.callTool("appium_scroll", { direction });
    await sleep(800);

    // Check visibility after scroll
    if (visionFirst) {
      const visible = await visionAssert(mcp, text);
      if (visible) {
        return {
          success: true,
          message: `Found "${text}" after ${scroll + 1} scroll(s) ${direction} (via vision)`,
        };
      }
    } else {
      // DOM check
      const elements = await getScreenElements(mcp);
      if (domContainsText(elements, text)) {
        return {
          success: true,
          message: `Found "${text}" after ${scroll + 1} scroll(s) ${direction}`,
        };
      }
      // Vision fallback in DOM mode
      if (useVision) {
        const visible = await visionAssert(mcp, text);
        if (visible) {
          return {
            success: true,
            message: `Found "${text}" after ${scroll + 1} scroll(s) ${direction} (via vision)`,
          };
        }
      }
    }
  }

  return {
    success: false,
    message: `"${text}" not found after ${maxScrolls} scroll(s) ${direction}`,
  };
}

async function executeStep(
  mcp: MCPClient,
  step: FlowStep,
  meta: FlowMeta,
  appResolver: AppResolver | undefined,
  tapPoll: FlowTapPollOptions
): Promise<ActionResult> {
  switch (step.kind) {
    case "launchApp": {
      const id = meta.appId?.trim();
      if (!id) {
        return { success: false, message: "launchApp requires appId in the YAML header" };
      }
      const r = await activateAppWithFallback(mcp, id);
      return { success: r.success, message: r.message };
    }
    case "openApp": {
      if (!appResolver) {
        return {
          success: false,
          message: "open … app steps need the installed-apps list (internal: pass AppResolver)",
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
      return { success: r.success, message: r.success ? `Launched ${step.query} (${pkg})` : r.message };
    }
    case "wait":
      await sleep(Math.round(step.seconds * 1000));
      return { success: true, message: `Waited ${step.seconds}s` };
    case "tap":
      return tapByLabel(mcp, step.label, tapPoll);
    case "type":
      return flowTypeText(mcp, step.text);
    case "enter":
      return pressEnterKey(mcp);
    case "back":
      await mcp.callTool("appium_mobile_press_key", { key: "BACK" });
      return { success: true, message: "Back" };
    case "home":
      await mcp.callTool("appium_mobile_press_key", { key: "HOME" });
      return { success: true, message: "Home" };
    case "swipe": {
      const result = await mcp.callTool("appium_scroll", { direction: step.direction });
      const text =
        result.content?.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : "")).join("") ??
        "";
      const bad = text.toLowerCase().includes("error") || text.toLowerCase().includes("failed");
      return {
        success: !bad,
        message: bad ? text.slice(0, 200) : `Swiped ${step.direction}`,
      };
    }
    case "assert":
      return assertTextVisible(mcp, step.text, tapPoll);
    case "scrollAssert":
      return scrollUntilVisible(mcp, step.text, step.direction, step.maxScrolls, tapPoll);
    case "done":
      return { success: true, message: step.message ?? "done" };
  }
}

export async function runYamlFlow(
  mcp: MCPClient,
  meta: FlowMeta,
  steps: FlowStep[],
  options: RunYamlFlowOptions = {}
): Promise<RunYamlFlowResult> {
  const stepDelayMs = options.stepDelayMs ?? 500;
  const appResolver = options.appResolver;
  const tapPoll: FlowTapPollOptions = {
    maxAttempts: options.tapTargetMaxAttempts ?? DEFAULT_TAP_MAX_ATTEMPTS,
    intervalMs: options.tapTargetPollIntervalMs ?? DEFAULT_TAP_POLL_MS,
  };
  const title = meta.name?.trim() || meta.appId || "YAML flow";
  const doneSteps = steps.filter(s => s.kind === "done");
  const total = steps.length;

  ui.printReplayGoal(title, total);

  let executed = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = stepLabel(step);
    const n = i + 1;

    if (step.kind === "done") {
      ui.printFlowStep(n, total, label, true);
      executed++;
      ui.printReplayResult(executed, total, 0);
      return {
        success: true,
        stepsExecuted: executed,
        stepsTotal: total,
        reason: step.message,
      };
    }

    const result = await executeStep(mcp, step, meta, appResolver, tapPoll);
    ui.printFlowStep(n, total, label, result.success);
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

    await sleep(stepDelayMs);
  }

  if (doneSteps.length === 0) {
    ui.printWarning("Flow ended without a done: step — treating as success");
  }

  const passed = executed;
  ui.printReplayResult(passed, total, 0);

  return {
    success: true,
    stepsExecuted: executed,
    stepsTotal: total,
  };
}
