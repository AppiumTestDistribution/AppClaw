/**
 * Downscale screenshots before sending to multimodal LLMs (Gemini, etc.).
 * API image tokens scale with resolution (see Gemini token docs); device captures stay full-res for Stark / Appium.
 */

import sharp from 'sharp';

function isSupportedBase64ImagePrefix(data: string): boolean {
  return data.startsWith('iVBOR') || data.startsWith('/9j/');
}

/**
 * If maxEdgePx > 0, resize so width and height are ≤ maxEdgePx (aspect preserved, no upscale).
 * Returns JPEG base64 (no data: prefix). On failure or when disabled, returns input unchanged.
 */
export async function prepareScreenshotForLlm(
  rawBase64: string | undefined,
  maxEdgePx: number
): Promise<string | undefined> {
  if (!rawBase64 || maxEdgePx <= 0) return rawBase64;
  if (!isSupportedBase64ImagePrefix(rawBase64)) return rawBase64;

  try {
    const input = Buffer.from(rawBase64, 'base64');
    const meta = await sharp(input).metadata();
    const resized = await sharp(input)
      .rotate()
      .resize({
        width: maxEdgePx,
        height: maxEdgePx,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    if (process.env.MCP_DEBUG === '1' || process.env.MCP_DEBUG === 'true') {
      const resizedMeta = await sharp(resized).metadata();
      const rawKB = Math.round(input.length / 1024);
      const outKB = Math.round(resized.length / 1024);
      console.log(
        `        [screenshot] ${meta.width}×${meta.height} ${meta.format} (${rawKB}KB) → ${resizedMeta.width}×${resizedMeta.height} jpeg (${outKB}KB)`
      );
    }

    return resized.toString('base64');
  } catch {
    return rawBase64;
  }
}
