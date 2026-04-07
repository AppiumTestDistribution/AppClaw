/**
 * Adaptive replayer — replays a recorded flow with resilience to UI changes.
 *
 * Instead of blindly replaying coordinates, it:
 * 1. Reads the current screen state
 * 2. Matches recorded elements to current elements (by text/id similarity)
 * 3. Uses the current element's coordinates/ID if the layout changed
 * 4. Falls back to recorded coordinates if no match found
 */

import { readFileSync } from 'fs';
import type { MCPClient } from '../mcp/types.js';
import { activateAppWithFallback } from '../mcp/activate-app.js';
import { findElement, getPageSource } from '../mcp/tools.js';
import type { ActionResult } from '../llm/schemas.js';
import type { UIElement, CompactUIElement } from '../perception/types.js';
import { detectPlatform } from '../perception/screen.js';
import { parseAndroidPageSource } from '../perception/android-parser.js';
import { parseIOSPageSource } from '../perception/ios-parser.js';
import { compactElement } from '../perception/element-filter.js';
import {
  findElementWithFallback,
  tapAtCoordinates,
  findByIdStrategies,
  findByVision,
  isAIElement,
  parseAIElementCoords,
} from '../agent/element-finder.js';
import type { Recording, RecordedStep, ContextElement } from './recorder.js';
import { isVisionLocateEnabled } from '../vision/locate-enabled.js';
import type { ToolCallDecision } from '../llm/provider.js';
import * as ui from '../ui/terminal.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ReplayOptions {
  /** If true, adapt element targeting to current screen (default: true) */
  adaptive?: boolean;
  /** Delay between steps in ms (default: 500) */
  stepDelay?: number;
  /** Max elements to consider when matching (default: 40) */
  maxElements?: number;
  /** Callback for each step */
  onStep?: (step: number, total: number, action: string, adapted: boolean) => void;
}

export interface ReplayResult {
  success: boolean;
  stepsExecuted: number;
  stepsTotal: number;
  adaptedSteps: number;
  failedSteps: ReplayFailure[];
}

export interface ReplayFailure {
  step: number;
  action: string;
  reason: string;
}

/** Load a recording from a JSON file */
export function loadRecording(filepath: string): Recording {
  const raw = readFileSync(filepath, 'utf-8');
  return JSON.parse(raw) as Recording;
}

/** Find the best matching current element for a recorded context element */
function findMatchingElement(
  recorded: ContextElement,
  currentElements: UIElement[]
): UIElement | null {
  // Priority 1: exact ID match
  if (recorded.id) {
    const idMatch = currentElements.find(
      (el) => el.accessibilityId === recorded.id || el.id === recorded.id
    );
    if (idMatch) return idMatch;
  }

  // Priority 2: exact text match
  if (recorded.text) {
    const textMatch = currentElements.find((el) => el.text === recorded.text);
    if (textMatch) return textMatch;
  }

  // Priority 3: case-insensitive text match
  if (recorded.text) {
    const lower = recorded.text.toLowerCase();
    const fuzzyMatch = currentElements.find((el) => el.text.toLowerCase() === lower);
    if (fuzzyMatch) return fuzzyMatch;
  }

  // Priority 4: partial text match
  if (recorded.text && recorded.text.length > 3) {
    const lower = recorded.text.toLowerCase();
    const partialMatch = currentElements.find(
      (el) => el.text.toLowerCase().includes(lower) || lower.includes(el.text.toLowerCase())
    );
    if (partialMatch) return partialMatch;
  }

  return null;
}

/** Replay a recording on a connected device */
export async function replayRecording(
  mcp: MCPClient,
  recording: Recording,
  options: ReplayOptions = {}
): Promise<ReplayResult> {
  const { adaptive = true, stepDelay = 500, maxElements = 40, onStep } = options;

  let adaptedSteps = 0;
  const failedSteps: ReplayFailure[] = [];

  ui.printReplayGoal(recording.goal, recording.steps.length);

  for (let i = 0; i < recording.steps.length; i++) {
    const step = recording.steps[i];
    const action = step.action;
    const toolName = action.toolName;
    const args = { ...action.args }; // mutable copy for adaptation

    // Skip "done" actions
    if (toolName === 'done') {
      ui.printReplayStep(i + 1, recording.steps.length, 'done', false, true);
      break;
    }

    let adapted = false;
    let screenElements: CompactUIElement[] = [];

    // If adaptive mode, try to match elements to current screen
    if (
      adaptive &&
      (toolName === 'smart_tap' || toolName === 'smart_type' || toolName === 'smart_long_press')
    ) {
      try {
        const pageSource = await getPageSource(mcp);
        const platform = detectPlatform(pageSource);
        const elements =
          platform === 'android'
            ? parseAndroidPageSource(pageSource)
            : parseIOSPageSource(pageSource);
        screenElements = elements.map(compactElement);

        // Find the target element from recording context
        const targetContext = step.contextElements.find(
          (ce) =>
            ce.text === args.text ||
            ce.id === args.elementId ||
            (args.coordX !== undefined &&
              ce.center[0] === args.coordX &&
              ce.center[1] === args.coordY)
        );

        if (targetContext) {
          const match = findMatchingElement(targetContext, elements);
          if (match && match.accessibilityId) {
            args.elementId = match.accessibilityId;
            adapted = true;
            adaptedSteps++;
          }
        }
      } catch {
        // If screen reading fails, use recorded values as-is
      }
    }

    // Execute the action (pass vision description for re-finding if the step used vision)
    const visionDesc = step.vision?.description;
    const result = await executeReplayAction(mcp, toolName, args, screenElements, visionDesc);

    onStep?.(i + 1, recording.steps.length, toolName, adapted);

    ui.printReplayStep(i + 1, recording.steps.length, toolName, adapted, result.success);

    if (!result.success) {
      failedSteps.push({
        step: i + 1,
        action: toolName,
        reason: result.message,
      });
    }

    await sleep(stepDelay);
  }

  const success = failedSteps.length === 0;
  const passed = recording.steps.length - failedSteps.length;
  ui.printReplayResult(passed, recording.steps.length, adaptedSteps);

  return {
    success,
    stepsExecuted: recording.steps.length,
    stepsTotal: recording.steps.length,
    adaptedSteps,
    failedSteps,
  };
}

/** Execute a single replay action — meta-tools use helpers, others go to MCP */
async function executeReplayAction(
  mcp: MCPClient,
  toolName: string,
  args: Record<string, unknown>,
  screenElements: CompactUIElement[] = [],
  visionDescription?: string
): Promise<ActionResult> {
  try {
    switch (toolName) {
      case 'smart_tap': {
        const elementId = args.elementId as string | undefined;
        const coordX = args.coordX as number | undefined;
        const coordY = args.coordY as number | undefined;
        const coords: [number, number] | undefined =
          coordX !== undefined && coordY !== undefined ? [coordX, coordY] : undefined;

        const uuid = await findElementWithFallback(mcp, screenElements, elementId, coords);

        if (uuid) {
          await mcp.callTool('appium_click', { elementUUID: uuid });
          return { success: true, message: `Tapped ${elementId || `[${coordX}, ${coordY}]`}` };
        }

        // Vision fallback: re-run AI vision find if the original step used it
        if (isVisionLocateEnabled() && visionDescription) {
          const visionUuid = await findByVision(mcp, visionDescription);
          if (visionUuid) {
            if (isAIElement(visionUuid)) {
              const visionCoords = parseAIElementCoords(visionUuid);
              if (visionCoords) {
                const tapped = await tapAtCoordinates(mcp, visionCoords.x, visionCoords.y);
                if (tapped) {
                  return {
                    success: true,
                    message: `Tapped "${visionDescription}" via AI vision at [${visionCoords.x}, ${visionCoords.y}]`,
                  };
                }
              }
            } else {
              await mcp.callTool('appium_click', { elementUUID: visionUuid });
              return { success: true, message: `Tapped "${visionDescription}" via AI vision` };
            }
          }
        }

        // Fallback: direct coordinate tap
        if (coords) {
          const tapped = await tapAtCoordinates(mcp, coords[0], coords[1]);
          if (tapped) {
            return { success: true, message: `Tapped at [${coords[0]}, ${coords[1]}] (direct)` };
          }
        }

        const target = elementId ? `"${elementId}"` : `coords [${coordX}, ${coordY}]`;
        return { success: false, message: `Could not find element ${target} on screen` };
      }

      case 'smart_type': {
        const elementId = args.elementId as string | undefined;
        const coordX = args.coordX as number | undefined;
        const coordY = args.coordY as number | undefined;
        const text = (args.text as string) ?? '';
        const coords: [number, number] | undefined =
          coordX !== undefined && coordY !== undefined ? [coordX, coordY] : undefined;

        // Check if the target is an editable element in current screen context
        const targetEl = elementId ? screenElements.find((el) => el.id === elementId) : undefined;

        if (targetEl?.editable) {
          // Target is directly editable — use it
          const uuid = await findElementWithFallback(mcp, screenElements, elementId, coords);
          if (uuid) {
            await mcp.callTool('appium_click', { elementUUID: uuid });
            await mcp.callTool('appium_clear_element', { elementUUID: uuid }).catch(() => {});
            await mcp.callTool('appium_set_value', { elementUUID: uuid, text });
            return { success: true, message: `Typed "${text}"` };
          }
        }

        // Target is not editable (label/container) — click it, then re-read
        // page source to find the actual editable element
        const clickUuid = await findElementWithFallback(mcp, screenElements, elementId, coords);
        if (clickUuid) {
          await mcp.callTool('appium_click', { elementUUID: clickUuid });
        }

        // Re-read page source to discover the real editable element
        const freshSource = await getPageSource(mcp);
        const platform = detectPlatform(freshSource);
        const freshElements =
          platform === 'android'
            ? parseAndroidPageSource(freshSource)
            : parseIOSPageSource(freshSource);

        const editableElements = freshElements.filter((el) => el.editable && el.enabled);

        let typeUuid: string | null = null;
        if (editableElements.length >= 1) {
          const el = editableElements[0];
          typeUuid = await findByIdStrategies(mcp, el.accessibilityId || el.id, el.text).catch(
            () => null
          );
        }

        if (!typeUuid) {
          const target = elementId ? `"${elementId}"` : 'any editable field';
          return { success: false, message: `Could not find an editable input near ${target}` };
        }

        await mcp.callTool('appium_click', { elementUUID: typeUuid });
        await mcp.callTool('appium_clear_element', { elementUUID: typeUuid }).catch(() => {});
        await mcp.callTool('appium_set_value', { elementUUID: typeUuid, text });
        return { success: true, message: `Typed "${text}"` };
      }

      case 'launch_app': {
        const id = (args.appId as string) ?? '';
        const r = await activateAppWithFallback(mcp, id);
        return { success: r.success, message: r.success ? `Launched ${id}` : r.message };
      }

      case 'go_back':
        await mcp.callTool('appium_mobile_press_key', { key: 'BACK' });
        return { success: true, message: 'Back' };

      case 'go_home':
        await mcp.callTool('appium_mobile_press_key', { key: 'HOME' });
        return { success: true, message: 'Home' };

      default:
        // Forward any other tool call directly to MCP
        try {
          const result = await mcp.callTool(toolName, args);
          const text =
            result.content
              ?.map((c: any) => (c.type === 'text' ? c.text : ''))
              .filter(Boolean)
              .join(' ') ?? '';
          return { success: true, message: text.slice(0, 200) || `${toolName} executed` };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, message };
        }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
}
