/**
 * Public types for the AppClaw Runner.
 *
 * The runner owns the whole mobile test run: device pool, parallel sessions,
 * lifecycle hooks, and reporting. Test authors only write `test(...)` bodies;
 * everything in `RunnerConfig` is set once (in `appclaw.config.ts`) by whoever
 * operates the lab/CI.
 */

import type { AppClaw } from '../sdk/index.js';
import type { AppClawOptions, Platform } from '../sdk/types.js';
import type { FixtureDefs } from './fixtures.js';

export type { Platform, AgentMode, LLMProvider } from '../sdk/types.js';
export type { AppClawOptions } from '../sdk/types.js';

/** A device the scheduler can lease. Discovered from a node's `select_device`. */
export interface Device {
  name: string;
  udid: string;
  state?: string;
  platform?: Platform;
}

/**
 * Which appium-mcp the runner talks to. Step 1 supports `local: true` — the
 * runner spawns a local appium-mcp in SSE mode and connects to it. Remote
 * nodes on other machines are step 2.
 */
export interface NodeConfig {
  /** Spawn a local appium-mcp `--httpStream` server and use it. Default true. */
  local?: boolean;
  /** Connect to an already-running SSE node instead of spawning one. */
  url?: string;
}

/** Context passed to every test body and the per-test hooks. */
export interface TestContext<State = unknown> {
  /** Value returned by `globalSetup`, shared across the whole run. */
  state: State;
  /** Test title. */
  title: string;
  /** 0-based retry attempt (0 = first try). */
  retry: number;
  /** The device this test is running on. */
  device: Device;
}

/** Outcome metadata handed to `afterEach`. */
export interface TestInfo {
  title: string;
  status: 'passed' | 'failed';
  error?: Error;
  durationMs: number;
  retry: number;
  device: Device;
}

export type TestFn<State = unknown> = (
  app: AppClaw,
  ctx: TestContext<State>
) => void | Promise<void>;

export type HookFn<State = unknown> = (
  app: AppClaw,
  ctx: TestContext<State>
) => void | Promise<void>;

/** Per-test options (the 2nd positional arg of `test`). */
export interface TestOptions {
  /** Override the run-wide retry count for this test. */
  retries?: number;
  /** Mark the test skipped (collected but not executed). */
  skip?: boolean;
  /** Run only this test (and other `.only`s) when any `.only` is present. */
  only?: boolean;
}

/** Arguments handed to `globalSetup` / `globalTeardown`. */
export interface GlobalSetupArgs {
  /** The discovered device pool for this run. */
  pool: Device[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: ResolvedConfig<any>;
}
export interface GlobalTeardownArgs<State = unknown> {
  state: State;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: ResolvedConfig<any>;
}

/**
 * The `appclaw.config.ts` shape (what `defineConfig` accepts).
 *
 * Extends the full `AppClawOptions` surface — so every per-session option
 * (provider, apiKey, model, platform, agentMode, maxSteps, waitTimeout,
 * scrollMode, video, capabilitiesFile, locatorCache, …) can be set directly on
 * the config and is forwarded to every test's AppClaw. The runner manages
 * `mcpTransport`/`mcpHost`/`mcpPort`/`deviceUdid` itself (those are overridden
 * per session); anything else you set here is passed straight through.
 *
 * The remaining fields below are runner-only orchestration. Every field is
 * optional; unset → built-in defaults, then CLI flags win. See `resolveConfig`.
 */
export interface RunnerConfig<State = unknown> extends AppClawOptions {
  // ── discovery / specs ──
  testDir?: string;
  testMatch?: string | string[];
  testIgnore?: string | string[];

  // ── execution (runner-level) ──
  concurrency?: number | 'auto';
  retries?: number;
  /** Per-test timeout (ms). Distinct from AppClaw's `waitTimeout` (element wait). */
  timeout?: number;

  // ── infra ──
  node?: NodeConfig;
  reporter?: string | string[];
  reportDir?: string;

  // ── lifecycle ──
  globalSetup?: (args: GlobalSetupArgs) => State | Promise<State>;
  globalTeardown?: (args: GlobalTeardownArgs<State>) => void | Promise<void>;
  deviceSetup?: HookFn<State>;
  beforeEach?: HookFn<State>;
  afterEach?: (app: AppClaw, info: TestInfo) => void | Promise<void>;
}

/** Per-run overrides parsed from the CLI; each wins over the config file. */
export interface CliOverrides {
  testFilter?: string[];
  platform?: Platform;
  concurrency?: number;
  retries?: number;
  timeout?: number;
  grep?: string;
  grepInvert?: string;
  shard?: { current: number; total: number };
  reporter?: string[];
}

/** Fully-resolved settings the engine reads (defaults ← config ← CLI). */
export interface ResolvedConfig<State = unknown> {
  testDir: string;
  testMatch: string[];
  testIgnore: string[];
  testFilter: string[];
  platform: Platform;
  concurrency: number | 'auto';
  retries: number;
  timeout: number;
  node: Required<Pick<NodeConfig, 'local'>> & NodeConfig;
  /** Pass-through AppClaw options forwarded to every test's session. */
  appOptions: AppClawOptions;
  reporter: string[];
  reportDir: string;
  grep?: string;
  grepInvert?: string;
  shard?: { current: number; total: number };
  // lifecycle (carried through from RunnerConfig)
  globalSetup?: RunnerConfig<State>['globalSetup'];
  globalTeardown?: RunnerConfig<State>['globalTeardown'];
  deviceSetup?: RunnerConfig<State>['deviceSetup'];
  beforeEach?: RunnerConfig<State>['beforeEach'];
  afterEach?: RunnerConfig<State>['afterEach'];
}

/**
 * The argument object passed to a fixtures-style test/fixture:
 * `test('…', async ({ app, device, state, …fixtures }) => { … })`.
 */
export interface FixtureArgs<State = unknown> {
  app: AppClaw;
  device: Device;
  state: State;
  title: string;
  retry: number;
}

/** A registered test case (flattened from any `describe` nesting). */
export interface TestCase {
  title: string;
  fullTitle: string;
  // Positional `(app, ctx)` or fixtures `({ app, … })` — runner detects which.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (...args: any[]) => void | Promise<void>;
  options: TestOptions;
  file?: string;
  /** Enclosing scope ids, outermost (file) first — drives beforeAll/afterAll. */
  scopeIds: string[];
  /** Fixture definitions in scope for this test (from `test.extend`). */
  fixtures?: FixtureDefs;
}

/** Result of a single test (after any retries). */
export interface TestResult {
  title: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  retries: number;
  device?: Device;
  error?: string;
  /** Spec file the test was declared in (for the run report). */
  file?: string;
  /** Report run id — links to the on-disk manifest at `.appclaw/runs/<runId>/`. */
  runId?: string;
}

/** Aggregate result of the whole run. */
export interface SuiteResult {
  results: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
  allPassed: boolean;
  durationMs: number;
}
