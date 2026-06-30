/**
 * Qwen2.5-VL native vision locator.
 *
 * Unlike the Stark/Gemini path (`[y,x]` normalized 0–1000), Qwen2.5-VL grounds
 * elements in its *own* contract: it returns `bbox_2d` pixel coordinates relative
 * to the image we send. We therefore track the downscale factor and scale the
 * returned box center back up to device pixels — the same device-pixel synthetic
 * UUID the Stark path produces (`ai-element:x,y:qwen`), so everything downstream
 * (`appium_click` via the synthetic UUID) is unchanged.
 *
 * Endpoint/model reuse the existing local-server vars (STARK_VISION_BASE_URL +
 * STARK_VISION_MODEL) — no new connection config. Runs against LM Studio's
 * OpenAI-compatible `/chat/completions` via raw fetch (no df-vision dependency).
 */

import sharp from 'sharp';

import { Config } from '../config.js';
import type { MCPClient, MCPToolResult } from '../mcp/types.js';
import { getStarkVisionBaseUrl, getStarkVisionModel } from './locate-enabled.js';
import { pngDimensionsFromBase64 } from './png-dimensions.js';
import { QwenVisionClient, parseQwenBoxes, type QwenBox } from './qwen-vision-client.js';
import { getScreenSizeForStark } from './window-size.js';

// Re-export so existing importers (and the verify harness) keep working from one source of truth.
export { parseQwenBoxes };
export type { QwenBox };

function isDebug(): boolean {
  return process.env.APPCLAW_DEBUG === '1' || process.env.APPCLAW_DEBUG === 'true';
}

/**
 * Max edge (px) for screenshots sent to Qwen. Qwen returns *pixel* coordinates,
 * so accuracy scales with resolution — 512 (the Gemini default) is too low for
 * tall phone screens. Configurable via QWEN_VISION_MAX_EDGE_PX (default 1024).
 */
function qwenMaxEdge(): number {
  const v = Config.QWEN_VISION_MAX_EDGE_PX;
  return Number.isFinite(v) && v > 0 ? v : 1024;
}

export interface DownscaleResult {
  base64: string;
  /** MIME type of the (possibly re-encoded) image, for the data URL we send. */
  mime: string;
  /** Pixel dimensions of the image we actually send — the basis for scaling Qwen's bbox. */
  width: number;
  height: number;
}

/**
 * Downscale a screenshot to <= the Qwen max edge and report the *sent* image's
 * pixel dimensions. Qwen returns coordinates relative to this image, so these
 * dimensions (not the device's) are the denominator for the scale factor.
 */
export async function downscaleForVision(base64: string): Promise<DownscaleResult> {
  const maxEdge = qwenMaxEdge();
  try {
    const input = Buffer.from(base64, 'base64');
    const meta = await sharp(input).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w > 0 && h > 0 && w <= maxEdge && h <= maxEdge) {
      // Already small enough — send as-is. Treat as PNG (raw Appium screenshots are PNG).
      return { base64, mime: 'image/png', width: w, height: h };
    }
    const resized = await sharp(input)
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const resizedMeta = await sharp(resized).metadata();
    return {
      base64: resized.toString('base64'),
      mime: 'image/jpeg',
      width: resizedMeta.width ?? maxEdge,
      height: resizedMeta.height ?? maxEdge,
    };
  } catch {
    // Fall back to the source image; recover dimensions from the header (PNG or JPEG).
    const dims = pngDimensionsFromBase64(base64);
    return {
      base64,
      mime: 'image/png',
      width: dims?.width ?? maxEdge,
      height: dims?.height ?? maxEdge,
    };
  }
}

function textFromMcpResult(result: MCPToolResult): string {
  for (const content of result.content) {
    if (content.type === 'text') return content.text;
  }
  return '';
}

/** Same behavior as mcp/tools.screenshot — kept local to avoid circular imports. */
async function captureScreenshotBase64(mcp: MCPClient): Promise<string | null> {
  const result = await mcp.callTool('appium_screenshot', {});
  for (const content of result.content) {
    if (content.type === 'image') return content.data;
  }
  const text = textFromMcpResult(result);
  if (text.startsWith('iVBOR') || text.startsWith('/9j/')) {
    return text;
  }
  if (text.includes('screenshot') && text.includes('/')) {
    try {
      const pathMatch = text.match(/:\s*(.+\.png)/);
      if (pathMatch) {
        const { readFileSync } = await import('fs');
        return readFileSync(pathMatch[1]).toString('base64');
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface QwenLocateResult {
  x: number;
  y: number;
  elementLabel: string;
}

function buildSyntheticUuid(x: number, y: number): string {
  const xr = Math.round(x);
  const yr = Math.round(y);
  return `ai-element:${xr},${yr}:qwen`;
}

/**
 * Convert a Qwen `bbox_2d` (pixels in the *sent* image) to the device-pixel
 * center. Exported so the scaling — the riskiest part of this path — can be unit
 * tested off-device. `scaleX = deviceWidth / sentWidth`, `scaleY = deviceHeight / sentHeight`.
 */
export function bboxCenterToDevice(
  bbox: [number, number, number, number],
  scaleX: number,
  scaleY: number
): { x: number; y: number } {
  const [x1, y1, x2, y2] = bbox;
  return {
    x: ((x1 + x2) / 2) * scaleX,
    y: ((y1 + y2) / 2) * scaleY,
  };
}

/**
 * Locate a tappable point from an NL instruction using a local Qwen2.5-VL server.
 * Returns device-pixel center coordinates + a synthetic `ai-element:x,y:qwen` UUID.
 * Mirrors `starkLocateTapTarget`'s signature so it's a drop-in in `findElementByVision`.
 */
export async function qwenLocateTapTarget(
  mcp: MCPClient,
  instruction: string,
  existingScreenshot?: string | null
): Promise<QwenLocateResult & { syntheticUuid: string }> {
  const baseUrl = getStarkVisionBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'Qwen vision requires a local OpenAI-compatible server (set STARK_VISION_BASE_URL)'
    );
  }
  const model = getStarkVisionModel();
  const trimmed = instruction.trim();

  const rawScreenshot = existingScreenshot || (await captureScreenshotBase64(mcp));
  if (!rawScreenshot) {
    throw new Error('Qwen vision: could not capture screenshot via MCP');
  }

  // Device size needs true device pixels — derive it from the raw screenshot.
  const screenSize = await getScreenSizeForStark(mcp, rawScreenshot);
  // Downscale for the model and capture the *sent* image's dimensions (the crux).
  const sent = await downscaleForVision(rawScreenshot);
  const scaleX = screenSize.width / sent.width;
  const scaleY = screenSize.height / sent.height;

  if (isDebug()) {
    const rawKB = Math.round(rawScreenshot.length / 1024);
    const newKB = Math.round(sent.base64.length / 1024);
    console.log(
      `        [qwen] screenshot ${rawKB}KB → ${newKB}KB | sent ${sent.width}×${sent.height} → device ${screenSize.width}×${screenSize.height} (scale ${scaleX.toFixed(3)},${scaleY.toFixed(3)})`
    );
  }

  const client = new QwenVisionClient({ baseUrl, model });
  const located = await client.locateBoxPixels(trimmed, sent.base64);
  if (!located) {
    throw new Error(`Qwen vision: no coordinates found for "${trimmed.slice(0, 80)}"`);
  }

  // Center of the box in sent-image pixels → device pixels.
  const { x: cx, y: cy } = bboxCenterToDevice(located.bbox, scaleX, scaleY);

  return {
    x: cx,
    y: cy,
    elementLabel: located.label,
    syntheticUuid: buildSyntheticUuid(cx, cy),
  };
}
