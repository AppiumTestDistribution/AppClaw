/**
 * submit_message skill — find and tap the Send button in messaging apps.
 *
 * Strategy:
 * 1. Look for common Send button patterns (accessibility IDs, text, icons)
 * 2. Tap the Send button
 * 3. Wait briefly for the message to be delivered
 * 4. Report result
 */

import type { MCPClient } from '../mcp/types.js';
import { findElement, getPageSource } from '../mcp/tools.js';
import type { ActionResult } from '../llm/schemas.js';
import { detectPlatform } from '../perception/screen.js';
import { parseAndroidPageSource } from '../perception/android-parser.js';
import { parseIOSPageSource } from '../perception/ios-parser.js';
import type { UIElement } from '../perception/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Common Send button patterns across messaging apps */
const SEND_PATTERNS = [
  // Accessibility IDs
  'send',
  'Send',
  'send_button',
  'send_message',
  'btn_send',
  'fab_send',
  'compose_send',
  // Text labels
  'Send',
  'send',
  'SEND',
  // WhatsApp
  'com.whatsapp:id/send',
  // Telegram
  'send_button',
  // Slack
  'Send Message',
  // Generic
  'submit',
  'Submit',
  'post',
  'Post',
];

function findSendButton(elements: UIElement[]): UIElement | null {
  // Priority 1: exact match on known send button IDs/text
  for (const pattern of SEND_PATTERNS) {
    const match = elements.find(
      (el) =>
        (el.clickable || el.action === 'tap') &&
        el.enabled &&
        (el.id.includes(pattern) ||
          el.accessibilityId.toLowerCase() === pattern.toLowerCase() ||
          el.text.toLowerCase() === pattern.toLowerCase())
    );
    if (match) return match;
  }

  // Priority 2: partial match
  const partialMatch = elements.find(
    (el) =>
      (el.clickable || el.action === 'tap') &&
      el.enabled &&
      (el.text.toLowerCase().includes('send') ||
        el.accessibilityId.toLowerCase().includes('send') ||
        el.id.toLowerCase().includes('send'))
  );
  if (partialMatch) return partialMatch;

  // Priority 3: look for ImageButton near bottom-right (common send icon position)
  const buttonCandidates = elements.filter(
    (el) =>
      (el.clickable || el.action === 'tap') &&
      el.enabled &&
      (el.type === 'ImageButton' || el.type === 'Button' || el.type === 'FloatingActionButton') &&
      el.center[1] > 1500 && // bottom of screen
      el.center[0] > 800 // right side
  );
  if (buttonCandidates.length > 0) {
    // Return the rightmost one
    return buttonCandidates.sort((a, b) => b.center[0] - a.center[0])[0];
  }

  return null;
}

export async function submitMessage(mcp: MCPClient): Promise<ActionResult> {
  try {
    // Get current screen elements
    const pageSource = await getPageSource(mcp);
    const platform = detectPlatform(pageSource);
    const elements =
      platform === 'android' ? parseAndroidPageSource(pageSource) : parseIOSPageSource(pageSource);

    const sendButton = findSendButton(elements);

    if (!sendButton) {
      // Fallback: try pressing Enter key
      try {
        await mcp.callTool('appium_mobile_press_key', { key: 'Enter' });
        await sleep(1000);
        return { success: true, message: 'Submitted via Enter key (no Send button found)' };
      } catch {
        return { success: false, message: 'Could not find Send button or use Enter to submit' };
      }
    }

    // Tap the send button using the best available locator
    if (sendButton.accessibilityId) {
      try {
        const uuid = await findElement(mcp, 'accessibility id', sendButton.accessibilityId);
        await mcp.callTool('appium_click', { elementUUID: uuid });
        await sleep(1000);
        return { success: true, message: `Tapped Send button (${sendButton.accessibilityId})` };
      } catch {
        // Fall through
      }
    }

    if (sendButton.id) {
      try {
        const uuid = await findElement(mcp, 'id', sendButton.id);
        await mcp.callTool('appium_click', { elementUUID: uuid });
        await sleep(1000);
        return { success: true, message: `Tapped Send button (${sendButton.id})` };
      } catch {
        // Fall through
      }
    }

    // Last resort: xpath by text
    try {
      const xpathQuery = `//*[@text='${sendButton.text}' or @content-desc='${sendButton.text}']`;
      const uuid = await findElement(mcp, 'xpath', xpathQuery);
      await mcp.callTool('appium_click', { elementUUID: uuid });
      await sleep(1000);
      return { success: true, message: `Tapped Send button via xpath` };
    } catch {
      return { success: false, message: "Found Send button but couldn't tap it" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `submit_message failed: ${message}` };
  }
}
