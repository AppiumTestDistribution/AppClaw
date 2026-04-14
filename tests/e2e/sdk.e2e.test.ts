/**
 * AppClaw SDK — End-to-End Tests
 *
 * These tests exercise the full SDK stack against a real device:
 *   AppClaw class → McpSession → appium-mcp → Appium → device
 *
 * ─── Prerequisites ──────────────────────────────────────────────────────────
 *   • Android device or emulator connected (adb devices shows a device)
 *   • Appium server reachable (stdio mode starts automatically via npx)
 *   • LLM credentials set for runGoal() tests
 *
 * ─── How to run ─────────────────────────────────────────────────────────────
 *   LLM_API_KEY=<key> npx vitest run tests/e2e/
 *
 *   With explicit provider:
 *   LLM_PROVIDER=anthropic LLM_API_KEY=sk-ant-... \
 *     PLATFORM=android npx vitest run tests/e2e/
 *
 * ─── Skip individual suites ─────────────────────────────────────────────────
 *   Set APPCLAW_E2E_SKIP_GOAL=1   to skip runGoal() tests (no API key needed)
 *   Set APPCLAW_E2E_SKIP_YOUTUBE=1 to skip YouTube tests (app may not be installed)
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppClaw } from '../../src/sdk/index.js';
import type { AppClawOptions, FlowResult, AgentResult } from '../../src/sdk/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOWS = resolve(__dirname, 'flows');

// ── Guards ────────────────────────────────────────────────────────────────────

const SKIP_GOAL = process.env.APPCLAW_E2E_SKIP_GOAL === '1';
const SKIP_YOUTUBE = process.env.APPCLAW_E2E_SKIP_YOUTUBE === '1';

const PROVIDER = (process.env.LLM_PROVIDER ?? 'gemini') as AppClawOptions['provider'];
const API_KEY =
  process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
const PLATFORM = (process.env.PLATFORM ?? 'android') as AppClawOptions['platform'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function flow(name: string): string {
  return resolve(FLOWS, name);
}

function assertFlowPassed(result: FlowResult, label: string): void {
  if (!result.success) {
    throw new Error(
      `[${label}] Flow failed in phase="${result.failedPhase ?? '?'}" ` +
        `at step ${result.failedStep ?? '?'}: ${result.error ?? 'unknown error'}`
    );
  }
}

// ── Suite: Teardown Safety (no device needed) ─────────────────────────────────

describe('SDK E2E — teardown safety (no device required)', () => {
  it('teardown() before any connect() does not throw', async () => {
    const app = new AppClaw({ provider: PROVIDER, apiKey: API_KEY, platform: PLATFORM });
    await expect(app.teardown()).resolves.not.toThrow();
  });

  it('double teardown() does not throw', async () => {
    const app = new AppClaw({ provider: PROVIDER, apiKey: API_KEY, platform: PLATFORM });
    await app.teardown();
    await expect(app.teardown()).resolves.not.toThrow();
  });
});

// ── Suite: runFlow() ──────────────────────────────────────────────────────────

describe('SDK E2E — runFlow()', () => {
  let app: AppClaw;

  beforeAll(() => {
    app = new AppClaw({
      provider: PROVIDER,
      apiKey: API_KEY,
      platform: PLATFORM,
      silent: false, // show output so device activity is visible during debugging
    });
  }, 30_000);

  afterAll(async () => {
    await app.teardown();
  }, 15_000);

  // ── Basic success ────────────────────────────────────────────────────────

  it('opens Settings and returns success=true', async () => {
    const result = await app.runFlow(flow('settings-open.yaml'));
    assertFlowPassed(result, 'settings-open');
    expect(result.success).toBe(true);
  }, 60_000);

  it('stepsUsed and stepsTotal are positive integers', async () => {
    const result = await app.runFlow(flow('settings-open.yaml'));
    expect(result.stepsUsed).toBeGreaterThan(0);
    expect(result.stepsTotal).toBeGreaterThan(0);
    expect(Number.isInteger(result.stepsUsed)).toBe(true);
    expect(Number.isInteger(result.stepsTotal)).toBe(true);
  }, 60_000);

  it('stepsUsed does not exceed stepsTotal', async () => {
    const result = await app.runFlow(flow('settings-open.yaml'));
    expect(result.stepsUsed).toBeLessThanOrEqual(result.stepsTotal);
  }, 60_000);

  it('failedStep and failedPhase are undefined on success', async () => {
    const result = await app.runFlow(flow('settings-open.yaml'));
    expect(result.failedStep).toBeUndefined();
    expect(result.failedPhase).toBeUndefined();
    expect(result.error).toBeUndefined();
  }, 60_000);

  // ── Phased flow ──────────────────────────────────────────────────────────

  it('phased flow (setup/steps/assertions) returns success=true', async () => {
    const result = await app.runFlow(flow('settings-phased.yaml'));
    assertFlowPassed(result, 'settings-phased');
    expect(result.success).toBe(true);
  }, 90_000);

  it('phased flow stepsTotal covers all phases', async () => {
    const result = await app.runFlow(flow('settings-phased.yaml'));
    // setup=2, steps=1, assertions=1 → at least 4 steps total
    expect(result.stepsTotal).toBeGreaterThanOrEqual(4);
  }, 90_000);

  // ── Failure handling ─────────────────────────────────────────────────────

  it('returns success=false when an assertion fails — does NOT throw', async () => {
    const result = await app.runFlow(flow('expected-failure.yaml'));
    expect(result.success).toBe(false);
  }, 60_000);

  it('provides error description on failure', async () => {
    const result = await app.runFlow(flow('expected-failure.yaml'));
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  }, 60_000);

  it('provides failedStep index on failure', async () => {
    const result = await app.runFlow(flow('expected-failure.yaml'));
    // The bad assert is step 3 (launchApp=1, wait=2, assert=3)
    expect(result.failedStep).toBeDefined();
    expect(result.failedStep).toBeGreaterThan(0);
  }, 60_000);

  // ── MCP connection reuse ─────────────────────────────────────────────────

  it('second runFlow() call reuses the MCP connection (no reconnect delay)', async () => {
    const t0 = Date.now();
    await app.runFlow(flow('settings-open.yaml')); // first call — connects
    const firstDuration = Date.now() - t0;

    const t1 = Date.now();
    await app.runFlow(flow('settings-open.yaml')); // second call — reuses connection
    const secondDuration = Date.now() - t1;

    // The second call should not be significantly slower than the first due to reconnect.
    // We allow up to 2× first call as a loose bound — the point is no new subprocess startup.
    // (startup typically adds 3-8s; same-connection calls don't have that penalty)
    expect(secondDuration).toBeLessThan(firstDuration + 8_000);
  }, 120_000);

  it('running two different flows shares one underlying connection', async () => {
    // Both flows should succeed — if connection was incorrectly closed between calls
    // the second one would throw or fail to connect.
    const r1 = await app.runFlow(flow('settings-open.yaml'));
    const r2 = await app.runFlow(flow('settings-phased.yaml'));
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  }, 120_000);
});

// ── Suite: runFlow() — YouTube (skippable) ────────────────────────────────────

describe.skipIf(SKIP_YOUTUBE)('SDK E2E — runFlow() YouTube', () => {
  let app: AppClaw;

  beforeAll(() => {
    app = new AppClaw({
      provider: PROVIDER,
      apiKey: API_KEY,
      platform: PLATFORM,
      silent: false,
    });
  }, 30_000);

  afterAll(async () => {
    await app.teardown();
  }, 15_000);

  it('searches YouTube and returns success=true', async () => {
    const result = await app.runFlow(flow('youtube-search.yaml'));
    assertFlowPassed(result, 'youtube-search');
    expect(result.success).toBe(true);
  }, 120_000);

  it('YouTube flow completes in a reasonable number of steps', async () => {
    const result = await app.runFlow(flow('youtube-search.yaml'));
    // Simple search flow should not need more than 20 steps
    expect(result.stepsUsed).toBeLessThanOrEqual(20);
  }, 120_000);
});

// ── Suite: runGoal() ──────────────────────────────────────────────────────────

describe.skipIf(SKIP_GOAL)('SDK E2E — runGoal()', () => {
  let app: AppClaw;

  beforeAll(() => {
    if (!API_KEY) {
      throw new Error(
        'runGoal() tests require LLM_API_KEY (or GEMINI_API_KEY / ANTHROPIC_API_KEY). ' +
          'Set APPCLAW_E2E_SKIP_GOAL=1 to skip these tests.'
      );
    }
    app = new AppClaw({
      provider: PROVIDER,
      apiKey: API_KEY,
      platform: PLATFORM,
      maxSteps: 10,
      silent: false,
    });
  }, 30_000);

  afterAll(async () => {
    await app.teardown();
  }, 15_000);

  it('completes a simple natural-language goal', async () => {
    const result = await app.runGoal('Open the Settings app');
    expect(result.success).toBe(true);
  }, 90_000);

  it('returns stepsUsed as a positive integer', async () => {
    const result = await app.runGoal('Open the Settings app');
    expect(result.stepsUsed).toBeGreaterThan(0);
    expect(Number.isInteger(result.stepsUsed)).toBe(true);
  }, 90_000);

  it('returns a non-empty reason string', async () => {
    const result = await app.runGoal('Open the Settings app');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  }, 90_000);

  it('returns AgentResult with history array', async () => {
    const result = await app.runGoal('Open the Settings app');
    expect(Array.isArray(result.history)).toBe(true);
  }, 90_000);

  it('caps stepsUsed at maxSteps option', async () => {
    // maxSteps=10 — stepsUsed must not exceed this
    const result = await app.runGoal('Open the Settings app');
    expect(result.stepsUsed).toBeLessThanOrEqual(10);
  }, 90_000);
});

// ── Suite: Mixed flow + goal ──────────────────────────────────────────────────

describe.skipIf(SKIP_GOAL)('SDK E2E — mixed runFlow() + runGoal()', () => {
  let app: AppClaw;

  beforeAll(() => {
    if (!API_KEY) {
      throw new Error('Mixed tests require LLM_API_KEY. Set APPCLAW_E2E_SKIP_GOAL=1 to skip.');
    }
    app = new AppClaw({
      provider: PROVIDER,
      apiKey: API_KEY,
      platform: PLATFORM,
      maxSteps: 10,
      silent: false,
    });
  }, 30_000);

  afterAll(async () => {
    await app.teardown();
  }, 15_000);

  it('runFlow() then runGoal() share one MCP connection without error', async () => {
    const flowResult = await app.runFlow(flow('settings-open.yaml'));
    const goalResult = await app.runGoal('Open the Settings app');

    expect(flowResult.success).toBe(true);
    expect(goalResult.success).toBe(true);
  }, 120_000);

  it('runGoal() then runFlow() share one MCP connection without error', async () => {
    const goalResult = await app.runGoal('Open the Settings app');
    const flowResult = await app.runFlow(flow('settings-open.yaml'));

    expect(goalResult.success).toBe(true);
    expect(flowResult.success).toBe(true);
  }, 120_000);
});

// ── Suite: teardown after use ─────────────────────────────────────────────────

describe('SDK E2E — teardown after use', () => {
  it('teardown() after runFlow() does not throw', async () => {
    const app = new AppClaw({
      provider: PROVIDER,
      apiKey: API_KEY,
      platform: PLATFORM,
    });

    await app.run('open YouTube app');
    await app.run('tap Search');
    await app.run('type Appium 3.0');
    await app.run('tap the search button');
    await app.run('wait 2 seconds');
    await app.run('scroll down');
    await app.teardown();
  }, 90_000);
});
