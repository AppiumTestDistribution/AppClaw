/**
 * Cross-surface contract validation.
 *
 * Verifies that the CLI's json-emitter event types match
 * the VSCode extension's bridge event interfaces.
 *
 * This test reads the source files and extracts event type definitions
 * to detect drift between the two surfaces.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const JSON_EMITTER = readFileSync(resolve(ROOT, 'src/json-emitter.ts'), 'utf-8');
const BRIDGE = readFileSync(resolve(ROOT, 'vscode-extension/src/bridge.ts'), 'utf-8');

/**
 * Extract event names from the JsonEvent union type in json-emitter.ts.
 * Matches patterns like: | { event: "connected"; data: { ... } }
 */
function extractCliEvents(): Map<string, string> {
  const events = new Map<string, string>();
  // Match each variant of the union: { event: "name"; data: { fields } }
  const regex = /\{\s*event:\s*"(\w+)";\s*data:\s*(\{[^}]+\})\s*\}/g;
  let match;
  while ((match = regex.exec(JSON_EMITTER)) !== null) {
    events.set(match[1], match[2]);
  }
  return events;
}

/**
 * Extract event names from the AppclawEvent union type in bridge.ts.
 * Matches patterns like: export interface ConnectedEvent { event: "connected"; data: { ... } }
 */
function extractBridgeEvents(): Map<string, string> {
  const events = new Map<string, string>();
  // Match interface blocks: interface XxxEvent { event: "name"; data: { ... } }
  const regex = /interface\s+(\w+Event)\s*\{[^}]*event:\s*"(\w+)"/g;
  let match;
  while ((match = regex.exec(BRIDGE)) !== null) {
    events.set(match[2], match[1]);
  }
  return events;
}

/**
 * Extract field names from a data type string like "{ transport: string }"
 */
function extractFields(dataType: string): Set<string> {
  const fields = new Set<string>();
  const regex = /(\w+)\s*[?:]?\s*:/g;
  let match;
  while ((match = regex.exec(dataType)) !== null) {
    fields.add(match[1]);
  }
  return fields;
}

/**
 * Extract fields from a bridge interface's data block.
 * Looks for "data: { ... }" inside the named interface.
 */
function extractBridgeDataFields(interfaceName: string): Set<string> {
  // Find the interface block and extract its data field
  const interfaceRegex = new RegExp(
    `interface\\s+${interfaceName}\\s*\\{[\\s\\S]*?data:\\s*\\{([^}]+)\\}`,
    'm'
  );
  const match = interfaceRegex.exec(BRIDGE);
  if (!match) return new Set();
  return extractFields(`{${match[1]}}`);
}

describe('Cross-surface: event type parity', () => {
  test('all CLI events exist in bridge', () => {
    const cliEvents = extractCliEvents();
    const bridgeEvents = extractBridgeEvents();

    const missing: string[] = [];
    for (const eventName of cliEvents.keys()) {
      if (!bridgeEvents.has(eventName)) {
        missing.push(eventName);
      }
    }

    if (missing.length > 0) {
      console.warn(`Bridge is missing event types: ${missing.join(', ')}`);
    }
    expect(missing).toEqual([]);
  });

  test('all bridge events exist in CLI', () => {
    const cliEvents = extractCliEvents();
    const bridgeEvents = extractBridgeEvents();

    const extra: string[] = [];
    for (const eventName of bridgeEvents.keys()) {
      if (!cliEvents.has(eventName)) {
        extra.push(eventName);
      }
    }

    if (extra.length > 0) {
      console.warn(`Bridge has event types not in CLI: ${extra.join(', ')}`);
    }
    expect(extra).toEqual([]);
  });

  test('event data fields match between CLI and bridge', () => {
    const cliEvents = extractCliEvents();
    const bridgeEvents = extractBridgeEvents();
    const mismatches: string[] = [];

    for (const [eventName, cliDataType] of cliEvents) {
      const bridgeInterface = bridgeEvents.get(eventName);
      if (!bridgeInterface) continue; // Already caught by "all CLI events exist in bridge"

      const cliFields = extractFields(cliDataType);
      const bridgeFields = extractBridgeDataFields(bridgeInterface);

      const missingInBridge = [...cliFields].filter((f) => !bridgeFields.has(f));
      const extraInBridge = [...bridgeFields].filter((f) => !cliFields.has(f));

      if (missingInBridge.length > 0) {
        mismatches.push(`${eventName}: bridge missing fields [${missingInBridge.join(', ')}]`);
      }
      if (extraInBridge.length > 0) {
        mismatches.push(`${eventName}: bridge has extra fields [${extraInBridge.join(', ')}]`);
      }
    }

    if (mismatches.length > 0) {
      console.warn('Event field mismatches:\n' + mismatches.map((m) => `  - ${m}`).join('\n'));
      console.warn(
        "\n⚠️  DRIFT DETECTED: Run 'review my changes' to see full cross-surface report"
      );
    }
    // Report mismatches — these indicate real drift between CLI and extension
    // Currently known: flow_done missing failedPhase + phaseResults in bridge
    expect(mismatches).toEqual([]);
  });
});

describe('Cross-surface: AppclawBridgeEvents covers all events', () => {
  test('all event names appear in AppclawBridgeEvents interface', () => {
    const cliEvents = extractCliEvents();
    const missing: string[] = [];

    for (const eventName of cliEvents.keys()) {
      // Check if the event name appears in the AppclawBridgeEvents interface
      const pattern = new RegExp(`${eventName}:\\s*\\[`);
      if (!pattern.test(BRIDGE)) {
        missing.push(eventName);
      }
    }

    if (missing.length > 0) {
      console.warn(`AppclawBridgeEvents missing handlers: ${missing.join(', ')}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('Cross-surface: extension formatEvent handles all events', () => {
  test('formatEvent has case for every event type', () => {
    const EXTENSION = readFileSync(resolve(ROOT, 'vscode-extension/src/extension.ts'), 'utf-8');
    const cliEvents = extractCliEvents();
    const unhandled: string[] = [];

    for (const eventName of cliEvents.keys()) {
      // Check for case "eventName": in the formatEvent function
      const pattern = new RegExp(`case\\s*"${eventName}"`);
      if (!pattern.test(EXTENSION)) {
        unhandled.push(eventName);
      }
    }

    if (unhandled.length > 0) {
      console.warn(`formatEvent missing cases: ${unhandled.join(', ')}`);
    }
    expect(unhandled).toEqual([]);
  });
});
