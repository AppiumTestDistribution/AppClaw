/**
 * Stark vision: screenshot + instruction → pixel coordinates for appium-mcp gestures.
 * Aligns with device-farm hub starkVision.service coordinate scaling (0–1000, [y, x] order).
 */

/**
 * `df-vision` ships a single webpack CJS bundle (`dist/bundle.js`). Default import is `module.exports`
 * so we destructure named exports here (avoids ESM named-import issues with CJS).
 */
import starkVision from "df-vision";

import type { MCPClient, MCPToolResult } from "../mcp/types.js";

const {
  StarkVisionClient,
  parseInstruction,
  detectSimpleAction,
  scaleCoordinates,
  findSubstringWithBrackets,
  sanitizeOutput,
} = starkVision;
import { getStarkVisionApiKey, getStarkVisionModel } from "./locate-enabled.js";
import { getScreenSizeForStark } from "./window-size.js";

function textFromMcpResult(result: MCPToolResult): string {
  for (const content of result.content) {
    if (content.type === "text") return content.text;
  }
  return "";
}

/** Same behavior as mcp/tools.screenshot — kept local to avoid circular imports. */
async function captureScreenshotBase64(mcp: MCPClient): Promise<string | null> {
  const result = await mcp.callTool("appium_screenshot", {});
  for (const content of result.content) {
    if (content.type === "image") return content.data;
  }
  const text = textFromMcpResult(result);
  if (text.startsWith("iVBOR") || text.startsWith("/9j/")) {
    return text;
  }
  if (text.includes("screenshot") && text.includes("/")) {
    try {
      const pathMatch = text.match(/:\s*(.+\.png)/);
      if (pathMatch) {
        const { readFileSync } = await import("fs");
        return readFileSync(pathMatch[1]).toString("base64");
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface StarkLocateResult {
  x: number;
  y: number;
  elementLabel: string;
}

function buildSyntheticUuid(x: number, y: number): string {
  const xr = Math.round(x);
  const yr = Math.round(y);
  return `ai-element:${xr},${yr}:stark`;
}

/**
 * Locate a tappable point from NL instruction using Stark + current screen via MCP.
 * When `existingScreenshot` is provided, reuses it instead of capturing a new one
 * (avoids a redundant MCP round-trip when a screenshot was already taken this step).
 */
export async function starkLocateTapTarget(
  mcp: MCPClient,
  instruction: string,
  existingScreenshot?: string | null
): Promise<StarkLocateResult & { syntheticUuid: string }> {
  const apiKey = getStarkVisionApiKey();
  if (!apiKey) {
    throw new Error("Stark vision requires LLM_API_KEY (Gemini)");
  }

  const trimmed = instruction.trim();
  const simple = detectSimpleAction(trimmed);
  if (simple) {
    throw new Error(
      `Instruction looks like a system gesture (${simple.action}), not a visual target. Use appium_scroll / appium_mobile_press_key instead.`
    );
  }

  const imageBase64 = existingScreenshot || await captureScreenshotBase64(mcp);
  if (!imageBase64) {
    throw new Error("Stark vision: could not capture screenshot via MCP");
  }

  const screenSize = await getScreenSizeForStark(mcp, imageBase64);
  const client = new StarkVisionClient({
    apiKey,
    model: getStarkVisionModel(),
    disableThinking: true,
  });

  const locateT0 = performance.now();
  const actions = await parseInstruction(client, trimmed, imageBase64);
  if (process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true") {
    const elapsed = Math.round(performance.now() - locateT0);
    console.log(`        [stark] parseInstruction ${elapsed}ms`);
  }

  for (const action of actions) {
    for (const locator of action.locators ?? []) {
      const coords = locator.coordinates;
      if (
        coords &&
        coords.length >= 2 &&
        !(coords[0] === 0 && coords[1] === 0)
      ) {
        const bbox = scaleCoordinates(coords as [number, number], screenSize);
        const { x, y } = bbox.center;
        return {
          x,
          y,
          elementLabel: locator.element || "",
          syntheticUuid: buildSyntheticUuid(x, y),
        };
      }

      if (locator.element) {
        const bboxT0 = performance.now();
        const bboxResponse = await client.getBoundingBox(locator.element, imageBase64);
        if (process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true") {
          console.log(`        [stark] getBoundingBox ${Math.round(performance.now() - bboxT0)}ms`);
        }
        const arrayStr = findSubstringWithBrackets(bboxResponse);
        if (arrayStr) {
          const bboxCoords = sanitizeOutput(arrayStr) as [number, number];
          if (!(bboxCoords[0] === 0 && bboxCoords[1] === 0)) {
            const bbox = scaleCoordinates(bboxCoords, screenSize);
            const { x, y } = bbox.center;
            return {
              x,
              y,
              elementLabel: locator.element,
              syntheticUuid: buildSyntheticUuid(x, y),
            };
          }
        }
      }
    }
  }

  throw new Error(`Stark vision: no coordinates found for "${trimmed.slice(0, 80)}"`);
}
