/**
 * Standalone helpers for Appium MCP tool calls that need post-processing.
 *
 * findElement  — extracts the UUID from the MCP response
 * getPageSource — extracts the XML text from the MCP response
 * screenshot   — extracts base64 image data from the MCP response
 *
 * Everything else should call MCPClient.callTool() directly.
 * The LLM discovers tools dynamically via tool-converter.ts.
 */

import type { MCPClient, LocatorStrategy, MCPToolResult } from "./types.js";
import { Config } from "../config.js";
import { getScreenSizeForStark } from "../vision/window-size.js";
import { pngDimensionsFromBase64 } from "../vision/png-dimensions.js";

function logVisionLocateBackend(
  backend: "stark" | "appium_mcp",
  phase: "attempt" | "success",
  description: string,
  detail?: string
): void {
  if (process.env.MCP_DEBUG !== "1" && process.env.MCP_DEBUG !== "true") return;
  const label =
    backend === "stark"
      ? "stark-vision (df-vision + Gemini)"
      : "mcp vision (appium_find_element / ai_instruction)";
  const short =
    description.length > 90 ? `${description.slice(0, 90)}…` : description;
  const extra = detail ? ` ${detail}` : "";
  console.log(`[vision-locate] ${phase} | ${label} | "${short}"${extra}`);
}

/** Extract text content from an MCP tool result */
export function extractText(result: MCPToolResult): string {
  for (const content of result.content) {
    if (content.type === "text") return content.text;
  }
  return "";
}

/**
 * Check if an MCP tool result indicates an error.
 * Appium-MCP tools catch errors internally and return them as text
 * (e.g. "Failed to set value... err: StaleElementReferenceError")
 * instead of throwing — so we must inspect the response text.
 */
export function isMCPError(result: MCPToolResult): boolean {
  const text = extractText(result).toLowerCase();
  return text.includes("failed") || text.includes("error");
}

/**
 * Find an element and return its Appium UUID.
 * Parses the UUID from appium-mcp's response text.
 */
export async function findElement(
  client: MCPClient,
  strategy: LocatorStrategy,
  selector: string
): Promise<string> {
  const result = await client.callTool("appium_find_element", { strategy, selector });
  const text = extractText(result);

  if (text.includes("Failed to find element") || text.includes("NoSuchElementError")) {
    throw new Error(`Element not found: "${selector}" (strategy: ${strategy})`);
  }

  const uuid = extractElementUUID(text);
  if (!uuid) {
    throw new Error(`Could not extract element UUID from response for "${selector}"`);
  }
  return uuid;
}

/** Get the page source XML as a string */
export async function getPageSource(client: MCPClient): Promise<string> {
  const result = await client.callTool("appium_get_page_source", {});
  return extractText(result);
}

/** Take a screenshot and return base64 image data, or null if unavailable */
export async function screenshot(client: MCPClient, elementUUID?: string): Promise<string | null> {
  const result = await client.callTool("appium_screenshot", {
    ...(elementUUID && { elementUUID }),
  });
  for (const content of result.content) {
    if (content.type === "image") return content.data;
  }
  const text = extractText(result);
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
      // File read failed
    }
  }
  return null;
}

/**
 * Find an element using AI vision (ai_instruction strategy).
 * Returns the synthetic ai-element UUID (e.g. "ai-element:540,960:bbox")
 * or throws if not found.
 *
 * When `existingScreenshot` is provided, reuses it instead of capturing a
 * fresh one — saves ~10-20ms MCP round-trip when the screen hasn't changed.
 */
export async function findElementByVision(
  client: MCPClient,
  description: string,
  existingScreenshot?: string | null
): Promise<string> {
  if (Config.VISION_LOCATE_PROVIDER === "stark") {
    logVisionLocateBackend("stark", "attempt", description);
    const { starkLocateTapTarget } = await import("../vision/stark-locate.js");
    const located = await starkLocateTapTarget(client, description, existingScreenshot);
    logVisionLocateBackend(
      "stark",
      "success",
      description,
      `→ (${Math.round(located.x)}, ${Math.round(located.y)}) ${located.syntheticUuid}`
    );
    if (process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true") {
      console.log(
        `        [vision-debug] stark: "${description.slice(0, 60)}" -> (${located.x}, ${located.y})`
      );
    }
    return located.syntheticUuid;
  }

  logVisionLocateBackend("appium_mcp", "attempt", description);
  const result = await client.callTool("appium_find_element", {
    strategy: "ai_instruction",
    ai_instruction: description,
  });
  const text = extractText(result);

  // Debug: log the raw response from appium-mcp for vision calls
  if (process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true") {
    console.log(`        [vision-debug] response: ${text.slice(0, 300)}`);
  }

  if (text.includes("Failed") || text.includes("Error") || text.includes("not found") || text.includes("not supported") || text.includes("not configured")) {
    throw new Error(`Vision find failed for "${description}": ${text.slice(0, 200)}`);
  }

  let uuid = extractElementUUID(text);
  if (!uuid) {
    throw new Error(`Could not extract element UUID from vision response for "${description}": ${text.slice(0, 200)}`);
  }

  // appium-mcp AI vision returns coordinates in screenshot image space, which may
  // differ from device pixel space (e.g. 540px screenshot vs 1080px device).
  // Scale the ai-element coordinates so all consumers get device-pixel values.
  if (uuid.startsWith("ai-element:")) {
    uuid = await scaleAIElementUuid(client, uuid);
  }

  logVisionLocateBackend("appium_mcp", "success", description, `→ ${uuid}`);
  return uuid;
}

/**
 * Scale ai-element coordinates from screenshot image space to device pixel space.
 * Rewrites the UUID string with scaled coordinates so all downstream consumers
 * (tapAtCoordinates, appium_click, LLM hints) use device pixels.
 */
export async function scaleAIElementUuid(mcp: MCPClient, uuid: string): Promise<string> {
  try {
    const imageBase64 = await screenshot(mcp);
    if (!imageBase64) return uuid;

    const imgSize = pngDimensionsFromBase64(imageBase64);
    if (!imgSize) return uuid;

    const deviceSize = await getScreenSizeForStark(mcp, imageBase64);

    // No scaling needed if resolutions match
    if (imgSize.width === deviceSize.width && imgSize.height === deviceSize.height) return uuid;

    const scaleX = deviceSize.width / imgSize.width;
    const scaleY = deviceSize.height / imgSize.height;

    // Parse: ai-element:x,y:bbox or ai-element:x,y:other
    const body = uuid.slice("ai-element:".length);
    const parts = body.split(":");
    const [xStr, yStr] = parts[0].split(",");
    const x = Math.round(Number(xStr) * scaleX);
    const y = Math.round(Number(yStr) * scaleY);

    // Rebuild with scaled coordinates, keep remaining parts
    const rest = parts.slice(1).join(":");
    return `ai-element:${x},${y}:${rest}`;
  } catch {
    return uuid;
  }
}

/**
 * Extract the element UUID from appium-mcp's findElement response.
 * Handles both standard UUIDs and vision-generated ai-element: synthetic UUIDs.
 *
 * Standard: "Successfully found element X with strategy Y. Element id 00000000-0000-000b-ffff-ffff000000de"
 * Vision:   "ai-element:540,960:[100,200,300,400]"
 */
function extractElementUUID(text: string): string | null {
  // Check for ai-element synthetic UUID first
  const aiMatch = text.match(/(ai-element:[^\s]+)/);
  if (aiMatch) return aiMatch[1];

  const uuidMatch = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (uuidMatch) return uuidMatch[1];

  const idMatch = text.match(/Element id\s+(\S+)/i);
  if (idMatch) return idMatch[1];

  return null;
}
