/**
 * AppClaw Runner — public entry point.
 *
 * Authors:
 *   import { test, defineConfig } from 'appclaw/runner';
 *   test('login works', async (app) => { await app.run('open Settings'); });
 *
 * Operators (appclaw.config.ts):
 *   export default defineConfig({ testDir: 'tests', retries: 1, ... });
 *
 * Programmatic:
 *   const runner = new Runner(resolveConfig(await loadRunnerConfig(path)));
 *   await runner.run();
 */

export { defineConfig, findConfigFile, loadRunnerConfig, resolveConfig } from './config.js';
export { test, describe, beforeAll, afterAll, collectTests, resetRegistry } from './registry.js';
export { Runner } from './runner.js';
export { discoverPool } from './pool.js';
export { startLocalSSENode } from './node-local.js';

export type {
  FixtureFn,
  FixtureDef,
  FixtureDefs,
  FixtureScope,
  FixtureOptions,
  UseFn,
} from './fixtures.js';
export type {
  RunnerConfig,
  ResolvedConfig,
  CliOverrides,
  Device,
  TestContext,
  TestInfo,
  TestFn,
  TestOptions,
  TestCase,
  TestResult,
  SuiteResult,
  FixtureArgs,
  Platform,
  AgentMode,
  LLMProvider,
} from './types.js';
