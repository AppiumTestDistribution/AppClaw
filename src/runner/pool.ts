/**
 * Device pool discovery.
 *
 * Connects to a node's SSE appium-mcp and lists its devices with the
 * race-safe `select_device { platform }` (list-only) call, then reduces the
 * output to a sorted `Device[]` (booted first). Reuses the existing
 * `parseDeviceList` so the parsing stays in one place.
 */

import { acquireSharedMCPClient } from '../mcp/client.js';
import { extractText } from '../mcp/tools.js';
import { parseDeviceList } from '../device/device-picker.js';
import type { Device, Platform } from './types.js';
import type { SSENode } from './node-local.js';

/**
 * Discover the devices a node can offer for a platform. Booted devices sort
 * first so a partial pool still prefers ready hardware.
 */
export async function discoverPool(node: SSENode, platform: Platform): Promise<Device[]> {
  const mcp = await acquireSharedMCPClient({
    transport: 'sse',
    host: node.host,
    port: node.port,
  });
  try {
    const result = await mcp.callTool('select_device', { platform });
    const text = extractText(result);
    const parsed = parseDeviceList(text, platform);

    // Dedup by udid. A single connected device makes appium-mcp auto-select it
    // and return a confirmation blob that parseDeviceList reads from two fields
    // (the message + the capabilities udid) → duplicate entries. Real
    // multi-device also duplicates an emulator as both AVD-name and serial.
    const byUdid = new Map<string, Device>();
    for (const d of parsed) {
      if (!d.udid) continue;
      if (!byUdid.has(d.udid)) {
        byUdid.set(d.udid, { name: d.name, udid: d.udid, state: d.state, platform });
      }
    }
    const devices: Device[] = [...byUdid.values()];

    devices.sort((a, b) => {
      const aBooted = a.state?.toLowerCase() === 'booted' ? 0 : 1;
      const bBooted = b.state?.toLowerCase() === 'booted' ? 0 : 1;
      if (aBooted !== bBooted) return aBooted - bBooted;
      return a.name.localeCompare(b.name);
    });

    return devices;
  } finally {
    // Release our discovery handle. The shared client stays alive as long as
    // any session handle (created later per worker) is still referencing it.
    await mcp.release();
  }
}
