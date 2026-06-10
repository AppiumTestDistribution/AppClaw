/**
 * Deterministic runtime primitives for external agent-facing CLIs.
 *
 * This module intentionally avoids AppClaw's goal loop and natural-language
 * step parsing. The caller decides which operation to perform.
 */

import { writeFile } from 'node:fs/promises';
import { loadConfig, type AppClawConfig } from '../config.js';
import { setupDevice } from '../device/index.js';
import type { Platform, DeviceType } from '../index.js';
import { createMCPClient } from '../mcp/client.js';
import { activateAppWithFallback } from '../mcp/activate-app.js';
import {
  findElement,
  findElementByVision,
  getPageSource,
  screenshot,
  extractText,
} from '../mcp/tools.js';
import type { LocatorStrategy, MCPClient } from '../mcp/types.js';
import { parseAndroidPageSource } from '../perception/android-parser.js';
import { parseIOSPageSource } from '../perception/ios-parser.js';
import { detectPlatform } from '../perception/screen.js';
import type { UIElement } from '../perception/types.js';
import { isVisionLocateEnabledFromConfig } from '../vision/locate-enabled.js';
import { visionExecute } from '../flow/vision-execute.js';

export interface AgentOpenOptions {
  app: string;
  platform: Platform;
  deviceType?: DeviceType;
  device?: string;
  udid?: string;
}

export type AgentSelector =
  | { kind: 'id'; value: string }
  | { kind: 'accessibility'; value: string }
  | { kind: 'text'; value: string };

export interface AgentElement {
  type: string;
  text: string;
  id: string;
  accessibilityId: string;
  center: [number, number];
  bounds: string;
  action: UIElement['action'];
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  selector?: AgentSelector;
}

export interface AgentSnapshot {
  platform: 'android' | 'ios';
  elements: AgentElement[];
}

export interface AgentActionResult {
  success: boolean;
  message: string;
  value?: unknown;
}

export interface AgentTarget {
  selector?: AgentSelector;
  coordinates?: [number, number];
}

interface OpenedSession {
  baseMcp: MCPClient;
  mcp: MCPClient;
  sessionId: string;
  deviceUdid: string;
  config: AppClawConfig;
}

export class AgentRuntimeSession {
  private constructor(private readonly opened: OpenedSession) {}

  static async open(options: AgentOpenOptions): Promise<AgentRuntimeSession> {
    const config = loadConfig({
      PLATFORM: options.platform,
      ...(options.deviceType && { DEVICE_TYPE: options.deviceType }),
      ...(options.device && { DEVICE_NAME: options.device }),
      ...(options.udid && { DEVICE_UDID: options.udid }),
    });
    const baseMcp = await createMCPClient({
      transport: config.MCP_TRANSPORT,
      host: config.MCP_HOST,
      port: config.MCP_PORT,
    });

    try {
      const device = await setupDevice(baseMcp, {
        cliPlatform: options.platform,
        cliDeviceType: options.deviceType ?? null,
        cliUdid: options.udid ?? null,
        cliDeviceName: options.device ?? null,
        config,
      });
      const activated = await activateAppWithFallback(device.scopedMcp, options.app);
      if (!activated.success) {
        await baseMcp
          .callTool('appium_session_management', { action: 'delete', sessionId: device.sessionId })
          .catch(() => undefined);
        throw new Error(activated.message);
      }
      return new AgentRuntimeSession({
        baseMcp,
        mcp: device.scopedMcp,
        sessionId: device.sessionId,
        deviceUdid: device.deviceUdid,
        config,
      });
    } catch (error) {
      await baseMcp.close().catch(() => undefined);
      throw error;
    }
  }

  get sessionId(): string {
    return this.opened.sessionId;
  }

  async close(): Promise<void> {
    await this.opened.baseMcp
      .callTool('appium_session_management', {
        action: 'delete',
        sessionId: this.opened.sessionId,
      })
      .catch(() => undefined);
    await this.opened.baseMcp.close();
  }

  async snapshot(interactiveOnly = false, maxElements = 80): Promise<AgentSnapshot> {
    const raw = await getPageSource(this.opened.mcp);
    const platform = detectPlatform(raw);
    const parsed = platform === 'android' ? parseAndroidPageSource(raw) : parseIOSPageSource(raw);
    const filtered = parsed.filter((element) => {
      if (!interactiveOnly) return true;
      return element.clickable || element.editable || element.longClickable || element.scrollable;
    });
    const elements = dedupeAndRank(filtered, maxElements).map(toAgentElement);
    return { platform, elements };
  }

  async press(target: AgentTarget): Promise<AgentActionResult> {
    const args = await this.targetGestureArgs(target);
    await this.opened.mcp.callTool('appium_gesture', { action: 'tap', ...args });
    return { success: true, message: 'Pressed target' };
  }

  async fill(target: AgentTarget, text: string): Promise<AgentActionResult> {
    const uuid = await this.requireElementUuid(target);
    await this.opened.mcp.callTool('appium_gesture', { action: 'tap', elementUUID: uuid });
    await this.opened.mcp
      .callTool('appium_clear_element', { elementUUID: uuid })
      .catch(() => undefined);
    const result = await this.opened.mcp.callTool('appium_set_value', {
      elementUUID: uuid,
      text,
    });
    return assertMcpSuccess(result, `Filled target with "${text}"`);
  }

  async longpress(target: AgentTarget, duration = 2000): Promise<AgentActionResult> {
    const args = await this.targetGestureArgs(target);
    await this.opened.mcp.callTool('appium_gesture', {
      action: 'long_press',
      duration,
      ...args,
    });
    return { success: true, message: `Long-pressed target (${duration}ms)` };
  }

  async swipe(direction: 'up' | 'down' | 'left' | 'right'): Promise<AgentActionResult> {
    await this.opened.mcp.callTool('appium_gesture', { action: 'scroll', direction });
    return { success: true, message: `Swiped ${direction}` };
  }

  async swipeElement(
    target: AgentTarget,
    direction: 'up' | 'down' | 'left' | 'right'
  ): Promise<AgentActionResult> {
    const uuid = await this.requireElementUuid(target);
    await this.opened.mcp.callTool('appium_gesture', {
      action: 'scroll',
      direction,
      elementUUID: uuid,
    });
    return { success: true, message: `Scrolled ${direction} within element` };
  }

  async pressKey(key: 'BACK' | 'HOME' | 'ENTER'): Promise<AgentActionResult> {
    await this.opened.mcp.callTool('appium_mobile_press_key', { key });
    return { success: true, message: `Pressed ${key.toLowerCase()}` };
  }

  async getText(target: AgentTarget): Promise<AgentActionResult> {
    const element = await this.resolveFromCurrentScreen(target);
    return { success: true, message: element.text, value: element.text };
  }

  async getAttrs(target: AgentTarget): Promise<AgentActionResult> {
    const element = await this.resolveFromCurrentScreen(target);
    return { success: true, message: 'Element attributes', value: element };
  }

  async isVisible(target: AgentTarget | string): Promise<AgentActionResult> {
    try {
      if (typeof target === 'string') {
        const snapshot = await this.snapshot(false);
        const needle = target.toLowerCase();
        const visible = snapshot.elements.some((element) =>
          [element.text, element.id, element.accessibilityId]
            .join(' ')
            .toLowerCase()
            .includes(needle)
        );
        return { success: visible, message: visible ? 'Visible' : 'Not visible', value: visible };
      }
      await this.resolveFromCurrentScreen(target);
      return { success: true, message: 'Visible', value: true };
    } catch {
      return { success: false, message: 'Not visible', value: false };
    }
  }

  async waitFor(
    condition: 'visible' | 'gone',
    target: AgentTarget | string,
    timeoutMs = 10000
  ): Promise<AgentActionResult> {
    const end = Date.now() + timeoutMs;
    while (Date.now() <= end) {
      const current = await this.isVisible(target);
      const satisfied = condition === 'visible' ? current.success : !current.success;
      if (satisfied) {
        return {
          success: true,
          message: condition === 'visible' ? 'Target became visible' : 'Target is gone',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { success: false, message: `Timed out waiting for target to be ${condition}` };
  }

  async saveScreenshot(path: string): Promise<AgentActionResult> {
    const image = await screenshot(this.opened.mcp);
    if (!image) return { success: false, message: 'Could not capture screenshot' };
    await writeFile(path, Buffer.from(image, 'base64'));
    return { success: true, message: `Saved screenshot to ${path}` };
  }

  async visionPress(description: string): Promise<AgentActionResult> {
    this.assertVisionConfigured();
    const uuid = await findElementByVision(this.opened.mcp, description);
    await this.opened.mcp.callTool('appium_gesture', { action: 'tap', elementUUID: uuid });
    return { success: true, message: `Pressed visual target "${description}"` };
  }

  async visionVisible(description: string): Promise<AgentActionResult> {
    this.assertVisionConfigured();
    const outcome = await visionExecute(
      this.opened.mcp,
      `assert that ${description} is visible on the screen`
    );
    if (!outcome) throw new Error('Vision execution is unavailable');
    return {
      success: outcome.result.success,
      message: outcome.result.message,
      value: outcome.result.success,
    };
  }

  async visionInfo(description: string): Promise<AgentActionResult> {
    this.assertVisionConfigured();
    const outcome = await visionExecute(this.opened.mcp, `get info about ${description}`);
    if (!outcome) throw new Error('Vision execution is unavailable');
    return {
      success: outcome.result.success,
      message: outcome.getInfoAnswer ?? outcome.result.message,
      value: outcome.getInfoAnswer ?? outcome.result.message,
    };
  }

  isVisionConfigured(): boolean {
    return isVisionLocateEnabledFromConfig(this.opened.config);
  }

  private assertVisionConfigured(): void {
    if (!this.isVisionConfigured()) {
      throw new Error(
        'Vision is not configured. Set STARK_VISION_API_KEY, GEMINI_API_KEY, or STARK_VISION_BASE_URL.'
      );
    }
  }

  private async targetGestureArgs(
    target: AgentTarget
  ): Promise<{ elementUUID: string } | { x: number; y: number }> {
    if (target.selector)
      return { elementUUID: await resolveSelector(this.opened.mcp, target.selector) };
    if (target.coordinates) return { x: target.coordinates[0], y: target.coordinates[1] };
    throw new Error('Target has no selector or coordinates');
  }

  private async requireElementUuid(target: AgentTarget): Promise<string> {
    if (!target.selector) {
      throw new Error(
        'Typing requires an element with a stable id, accessibility id, or text selector'
      );
    }
    return resolveSelector(this.opened.mcp, target.selector);
  }

  private async resolveFromCurrentScreen(target: AgentTarget): Promise<AgentElement> {
    const snapshot = await this.snapshot(false);
    if (target.selector) {
      const element = snapshot.elements.find((item) => matchesSelector(item, target.selector!));
      if (element) return element;
    } else if (target.coordinates) {
      const element = snapshot.elements.find(
        (item) =>
          item.center[0] === target.coordinates![0] && item.center[1] === target.coordinates![1]
      );
      if (element) return element;
    }
    throw new Error('Target is not visible on the current screen');
  }
}

function toAgentElement(element: UIElement): AgentElement {
  return {
    type: element.type,
    text: element.text || element.hint,
    id: element.id,
    accessibilityId: element.accessibilityId,
    center: element.center,
    bounds: element.bounds,
    action: element.action,
    enabled: element.enabled,
    checked: element.checked,
    focused: element.focused,
    selector: preferredSelector(element),
  };
}

function preferredSelector(element: UIElement): AgentSelector | undefined {
  if (element.id) return { kind: 'id', value: element.id };
  if (element.accessibilityId) return { kind: 'accessibility', value: element.accessibilityId };
  if (element.text) return { kind: 'text', value: element.text };
  return undefined;
}

function dedupeAndRank(elements: UIElement[], maxElements: number): UIElement[] {
  const byPosition = new Map<string, UIElement>();
  for (const element of elements) {
    const key = `${element.center[0]},${element.center[1]}`;
    const previous = byPosition.get(key);
    if (!previous || rank(element) > rank(previous)) byPosition.set(key, element);
  }
  return [...byPosition.values()].sort((a, b) => rank(b) - rank(a)).slice(0, maxElements);
}

function rank(element: UIElement): number {
  return (
    (element.enabled ? 10 : 0) +
    (element.editable ? 8 : 0) +
    (element.clickable ? 5 : 0) +
    (element.text ? 3 : 0) +
    (element.id || element.accessibilityId ? 2 : 0)
  );
}

function matchesSelector(element: AgentElement, selector: AgentSelector): boolean {
  if (selector.kind === 'id') return element.id === selector.value;
  if (selector.kind === 'accessibility') return element.accessibilityId === selector.value;
  return element.text === selector.value;
}

async function resolveSelector(mcp: MCPClient, selector: AgentSelector): Promise<string> {
  const [strategy, value] = locatorForSelector(selector);
  return findElement(mcp, strategy, value);
}

function locatorForSelector(selector: AgentSelector): [LocatorStrategy, string] {
  if (selector.kind === 'id') return ['id', selector.value];
  if (selector.kind === 'accessibility') return ['accessibility id', selector.value];
  return [
    'xpath',
    `//*[@text=${xpathLiteral(selector.value)} or @label=${xpathLiteral(selector.value)} or @name=${xpathLiteral(selector.value)}]`,
  ];
}

function xpathLiteral(text: string): string {
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  const parts = text.split('"').map((part) => `"${part}"`);
  return `concat(${parts.join(", '\"', ")})`;
}

function assertMcpSuccess(
  result: { content: Array<{ type: string; text?: string }> },
  message: string
): AgentActionResult {
  const text = extractText(result as any);
  if (/\b(error|failed)\b/i.test(text)) return { success: false, message: text };
  return { success: true, message };
}
