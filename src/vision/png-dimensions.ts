/**
 * Read width/height from a base64 image payload (PNG or JPEG).
 * Used when MCP does not expose window rect and the screenshot must be parsed.
 */

export function pngDimensionsFromBase64(base64: string): { width: number; height: number } | null {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 24) return null;

  // PNG: read IHDR chunk
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 20000 || height > 20000) return null;
    return { width, height };
  }

  // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2) which contains dimensions.
  // This handles MJPEG screenshots which are JPEG-encoded.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset < buf.length - 8) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      // SOF0 (0xC0) or SOF2 (0xC2) — baseline or progressive JPEG
      if (marker === 0xc0 || marker === 0xc2) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        if (width < 1 || height < 1 || width > 20000 || height > 20000) return null;
        return { width, height };
      }
      // Skip to next marker using segment length
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }

  return null;
}
