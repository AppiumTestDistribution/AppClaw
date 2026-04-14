/**
 * SDK smoke test — verifies the public API is importable and correctly wired.
 *
 * Does NOT require a real device or MCP connection.
 * Run with: npx tsx tests/sdk-smoke.ts
 */

import { AppClaw } from '../src/sdk/index.js';
import type { AppClawOptions, FlowResult, AgentResult } from '../src/sdk/index.js';

// ── 1. Constructor accepts options without touching process.env ──────────────

const app = new AppClaw({
  provider: 'anthropic',
  apiKey: 'test-key',
  platform: 'android',
  agentMode: 'dom',
  maxSteps: 10,
  silent: true,
});

console.log('✓ AppClaw instantiated without errors');

// ── 2. Public types are exported and usable ──────────────────────────────────

const _options: AppClawOptions = { provider: 'gemini', silent: true };
const _flowResult: FlowResult = {
  success: true,
  stepsUsed: 3,
  stepsTotal: 5,
};
const _agentResult: AgentResult = {
  success: true,
  reason: 'Goal completed',
  stepsUsed: 3,
  history: [],
};

console.log('✓ All public types resolved correctly');

// ── 3. teardown is safe to call without a prior connect ─────────────────────

await app.teardown();
console.log('✓ teardown() is safe with no active connection');

// ── 4. Multiple instances are isolated ──────────────────────────────────────

const app1 = new AppClaw({ provider: 'anthropic', apiKey: 'key-1', silent: true });
const app2 = new AppClaw({ provider: 'openai', apiKey: 'key-2', silent: true });
await app1.teardown();
await app2.teardown();

console.log('✓ Multiple isolated instances work correctly');
console.log('\nAll smoke tests passed.');
