/**
 * The Runner — control plane for a mobile test run.
 *
 * Orchestration:
 *   start node (local SSE) → discover pool → globalSetup({pool})
 *     → dispatch tests across devices (sticky device per worker)
 *         per device: deviceSetup once
 *         per test:   beforeEach → testFn → afterEach   (+ retries, timeout)
 *     → globalTeardown({state}) → write report → stop node
 *
 * Parallel sessions all share the one SSE node (acquireSharedMCPClient is keyed
 * by transport:host:port and ref-counted), each pinning its own udid + locally
 * allocated driver ports. Device isolation is correct today because udid flows
 * through the per-instance config, not the global singleton.
 *
 * NOTE (config isolation): a single run uses uniform LLM/agentMode config, so
 * the global Config singleton's "last write wins" is harmless here. Per-test
 * agentMode/provider overrides will require AsyncLocalStorage-scoped config —
 * deliberately deferred. This is the seam.
 */

import { AppClaw } from '../sdk/index.js';
import type { AppClawOptions } from '../sdk/types.js';
import { startLocalSSENode, type SSENode } from './node-local.js';
import { discoverPool } from './pool.js';
import {
  test as registryTest,
  describe as registryDescribe,
  collectTests,
  getScope,
} from './registry.js';
import {
  parseFirstParam,
  buildFixtures,
  createWorkerStore,
  teardownWorkerFixtures,
  type WorkerFixtureStore,
} from './fixtures.js';
import { writeSuiteReport, newSuiteId } from './report.js';
import { PlainReporter, type RunnerReporter } from './reporter.js';
import type {
  Device,
  ResolvedConfig,
  SuiteResult,
  TestCase,
  TestContext,
  TestInfo,
  TestResult,
} from './types.js';

/** Per-worker (per-device) scope tracking for beforeAll/afterAll. */
interface WorkerScopeState {
  /** Scope ids whose beforeAll already ran on this device. */
  ranBeforeAll: Set<string>;
  /** Scope ids with an afterAll, in entry order (run in reverse at drain). */
  entered: string[];
}

export class Runner<State = unknown> {
  readonly config: ResolvedConfig<State>;
  /** Re-exported so programmatic users can register without importing registry. */
  readonly test = registryTest;
  readonly describe = registryDescribe;

  /** Address of the SSE node every leased session connects to (set in run()). */
  private nodeHost = '127.0.0.1';
  private nodePort = 0;
  /** Live view (TUI) or line output (plain) — chosen per run in run(). */
  private reporter: RunnerReporter = new PlainReporter();
  /** Suite identity for this run — tags every test's manifest + the report. */
  private suiteId = '';
  private suiteName = 'AppClaw Runner';

  constructor(config: ResolvedConfig<State>) {
    this.config = config;
  }

  /** Run all registered (or provided) tests across the device pool. */
  async run(cases?: TestCase[]): Promise<SuiteResult> {
    const started = Date.now();
    const tests = this.filterAndShard(cases ?? collectTests());
    this.suiteId = newSuiteId();

    const { reporter, cleanup } = await this.makeReporter();
    this.reporter = reporter;
    try {
      reporter.starting('Starting appium-mcp…');
      const { node, ownsNode } = await this.connectNode();
      this.nodeHost = node.host;
      this.nodePort = node.port;
      try {
        reporter.starting('Discovering devices…');
        const pool = await discoverPool(node, this.config.platform);
        if (pool.length === 0) {
          throw new Error(
            `No ${this.config.platform} devices found. Connect a device/emulator and retry.`
          );
        }

        const skipped = tests.filter((t) => t.options.skip).length;
        const runnable = tests.length - skipped;
        const workers = this.workerCount(pool.length, runnable);
        this.noticeUtilization(reporter, pool.length, runnable, workers);
        reporter.runStart({
          platform: this.config.platform,
          devices: pool.slice(0, workers),
          workers,
          total: tests.length,
          runnable,
          skipped,
          files: new Set(tests.map((t) => t.file)).size,
          retries: this.config.retries,
        });

        const state = (await this.config.globalSetup?.({ pool, config: this.config })) as State;

        const results = await this.dispatch(tests, pool, node, state);

        await this.config.globalTeardown?.({ state, config: this.config });

        const suite: SuiteResult = this.summarize(results, Date.now() - started);
        const reportPath = await writeSuiteReport(suite, {
          suiteId: this.suiteId,
          suiteName: this.suiteName,
          platform: this.config.platform,
          startedAt: new Date(started).toISOString(),
          devices: pool.slice(0, workers),
          workers,
          provider: this.config.appOptions.provider,
          model: this.config.appOptions.model,
        });
        reporter.runEnd(suite, reportPath);
        return suite;
      } finally {
        if (ownsNode) await node.stop();
      }
    } finally {
      await cleanup();
    }
  }

  /**
   * Pick the reporter for this run. The live Ink dashboard is the default on an
   * interactive TTY; plain line output is used in CI, when piped, or on opt-out
   * (`APPCLAW_TUI=off` / `--reporter plain`). The Ink module is imported lazily
   * so the plain path never loads React.
   */
  private async makeReporter(): Promise<{
    reporter: RunnerReporter;
    cleanup: () => Promise<void>;
  }> {
    const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY) && !process.env.CI;
    const optedOut = process.env.APPCLAW_TUI === 'off' || this.config.reporter.includes('plain');
    if (interactive && !optedOut) {
      try {
        const { activateRunnerTui } = await import('./tui/activate.js');
        return activateRunnerTui();
      } catch {
        /* terminal can't host Ink — fall through to plain */
      }
    }
    return { reporter: new PlainReporter(), cleanup: async () => {} };
  }

  /** Worker count = concurrency (or device count), capped by pool and test count. */
  private workerCount(poolLen: number, runnableLen: number): number {
    const want = this.config.concurrency === 'auto' ? poolLen : this.config.concurrency;
    return Math.max(1, Math.min(want, poolLen, runnableLen || 1));
  }

  /**
   * Tell the user when the effective worker count doesn't match the hardware,
   * in either direction — asking for more workers than devices (clamped down),
   * or leaving devices on the bench (throttled by `--workers`, or fewer tests
   * than devices). Silence here reads as "everything's fully utilized" when it
   * may not be.
   */
  private noticeUtilization(
    reporter: RunnerReporter,
    poolLen: number,
    runnable: number,
    workers: number
  ): void {
    const requested = this.config.concurrency === 'auto' ? null : this.config.concurrency;

    if (requested != null && requested > poolLen) {
      reporter.notice(
        `requested ${requested} workers, capped to ${workers} — only ${poolLen} device(s) connected`
      );
      return;
    }

    const idle = poolLen - workers;
    if (idle > 0) {
      const throttledByWorkers = requested != null && requested <= poolLen && requested <= runnable;
      const reason = throttledByWorkers ? `--workers ${requested}` : `only ${runnable} test(s)`;
      reporter.notice(
        `${poolLen} devices available, using ${workers} (${reason}) — ` +
          `${idle} device${idle === 1 ? '' : 's'} idle`
      );
    }
  }

  // ── node lifecycle ────────────────────────────────────────────────
  private async connectNode(): Promise<{ node: SSENode; ownsNode: boolean }> {
    if (this.config.node.url) {
      const u = new URL(this.config.node.url);
      const node: SSENode = {
        host: u.hostname,
        port: Number(u.port),
        recentLog: () => '', // external server's process isn't ours to read
        async stop() {
          /* externally owned */
        },
      };
      return { node, ownsNode: false };
    }
    const node = await startLocalSSENode();
    return { node, ownsNode: true };
  }

  // ── test list shaping ─────────────────────────────────────────────
  private filterAndShard(all: TestCase[]): TestCase[] {
    let tests = all;
    if (this.config.grep) {
      const re = new RegExp(this.config.grep);
      tests = tests.filter((t) => re.test(t.fullTitle));
    }
    if (this.config.grepInvert) {
      const re = new RegExp(this.config.grepInvert);
      tests = tests.filter((t) => !re.test(t.fullTitle));
    }
    if (this.config.shard) {
      const { current, total } = this.config.shard;
      tests = tests.filter((_, i) => i % total === current - 1);
    }
    // Platform gate: a test tagged for specific platform(s) is skipped (not run,
    // not failed) when this run's platform isn't among them. Keeps a shared spec
    // file valid across an Android run and an iOS run.
    const runPlatform = this.config.platform;
    tests = tests.map((t) => {
      const want = t.options.platform;
      if (!want) return t;
      const allowed = Array.isArray(want) ? want : [want];
      if (allowed.includes(runPlatform)) return t;
      return { ...t, options: { ...t.options, skip: true } };
    });
    return tests;
  }

  // ── scheduler: sticky device per worker, shared work queue ─────────
  private async dispatch(
    tests: TestCase[],
    pool: Device[],
    node: SSENode,
    state: State
  ): Promise<TestResult[]> {
    const results: TestResult[] = [];

    // Skipped tests don't consume a device — record and drop them.
    const runnable = tests.filter((t) => {
      if (t.options.skip) {
        results.push({
          title: t.fullTitle,
          status: 'skipped',
          durationMs: 0,
          retries: 0,
          file: t.file,
        });
        return false;
      }
      return true;
    });

    const workers = this.workerCount(pool.length, runnable.length);

    const queue = [...runnable];
    const setupDone = new Set<string>();

    const workerLoop = async (workerIndex: number): Promise<void> => {
      const device = pool[workerIndex];
      // Per-(scope, device) tracking: which scopes' beforeAll already ran on
      // this device, and the order they were entered (for reverse afterAll).
      const scopeState: WorkerScopeState = { ranBeforeAll: new Set(), entered: [] };
      // Per-worker cache for worker-scoped fixtures (built once, reused).
      const workerStore = createWorkerStore();
      while (true) {
        const tc = queue.shift();
        if (!tc) break;
        // `queue.length` here is the authoritative count still waiting.
        this.reporter.testStart({ title: tc.fullTitle, device, remaining: queue.length });
        const result = await this.runOne(
          tc,
          device,
          node,
          state,
          setupDone,
          scopeState,
          workerStore
        );
        results.push(result);
      }
      // Scope teardown: afterAll for every entered scope, innermost first.
      await this.runAfterAll(device, state, scopeState);
      // Worker-scoped fixture teardown (reverse build order), once per worker.
      await teardownWorkerFixtures(workerStore);
    };

    await Promise.all(Array.from({ length: workers }, (_, i) => workerLoop(i)));
    return results;
  }

  // ── one test, with retries + timeout ──────────────────────────────
  private async runOne(
    tc: TestCase,
    device: Device,
    node: SSENode,
    state: State,
    setupDone: Set<string>,
    scopeState: WorkerScopeState,
    workerStore: WorkerFixtureStore
  ): Promise<TestResult> {
    const maxRetries = tc.options.retries ?? this.config.retries;
    let lastError: Error | undefined;
    let lastRunId: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const t0 = Date.now();
      const app = new AppClaw(this.appOptions(device, tc.fullTitle));
      lastRunId = app.runId;
      const ctx: TestContext<State> = {
        state,
        title: tc.fullTitle,
        retry: attempt,
        device,
      };
      let error: Error | undefined;
      let fixtureTeardown: (() => Promise<void>) | undefined;
      try {
        // Device scope (once per device): deviceSetup.
        if (!setupDone.has(device.udid) && this.config.deviceSetup) {
          await this.config.deviceSetup(app, ctx);
        }
        setupDone.add(device.udid);

        // Scope chain (file → describe…): beforeAll, once per (scope, device).
        // Hooks share this test's session, so device-side state persists to the
        // rest of the scope's tests. Marked ran only after success, so a failed
        // beforeAll re-runs on retry rather than silently skipping setup.
        for (const sid of tc.scopeIds) {
          if (scopeState.ranBeforeAll.has(sid)) continue;
          const scope = getScope(sid);
          for (const h of scope?.beforeAll ?? []) await h(app, ctx);
          scopeState.ranBeforeAll.add(sid);
          if (scope?.afterAll.length) scopeState.entered.push(sid);
        }

        if (this.config.beforeEach) await this.config.beforeEach(app, ctx);

        // Invoke the test. Detect the callback form from its first parameter:
        //  - object pattern `({ app, … })` → build & inject fixtures
        //  - positional `(app, ctx)`       → legacy form, unchanged
        const param = parseFirstParam(tc.fn);
        if (param.mode === 'object') {
          const builtins = {
            app,
            device,
            state,
            title: tc.fullTitle,
            retry: attempt,
          };
          const built = await buildFixtures(param.keys, tc.fixtures ?? {}, builtins, workerStore);
          fixtureTeardown = built.teardown;
          await this.withTimeout(Promise.resolve(tc.fn(built.values)), tc.fullTitle);
        } else {
          await this.withTimeout(Promise.resolve(tc.fn(app, ctx)), tc.fullTitle);
        }
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        // Snapshot the appium-mcp server log at the failure moment so the
        // report's failure panel can show what the server was doing. Captured
        // before teardown finalizes this attempt's manifest.
        const mcpLog = node.recentLog();
        if (mcpLog) app.attachAppiumMcpLog(mcpLog);
      }

      const info: TestInfo = {
        title: tc.fullTitle,
        status: error ? 'failed' : 'passed',
        error,
        durationMs: Date.now() - t0,
        retry: attempt,
        device,
      };
      try {
        if (this.config.afterEach) await this.config.afterEach(app, info);
      } catch (hookErr) {
        if (!error) error = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
      } finally {
        // Fixture teardown (reverse order) before the session closes.
        if (fixtureTeardown) await fixtureTeardown();
        await app.teardown().catch(() => {});
      }

      if (!error) {
        this.reporter.testEnd({
          title: tc.fullTitle,
          device,
          status: 'passed',
          durationMs: info.durationMs,
          retries: attempt,
        });
        return {
          title: tc.fullTitle,
          status: 'passed',
          durationMs: info.durationMs,
          retries: attempt,
          device,
          file: tc.file,
          runId: lastRunId,
        };
      }
      lastError = error;
      if (attempt < maxRetries) {
        this.reporter.testRetry({ title: tc.fullTitle, device, attempt: attempt + 1 });
      }
    }

    this.reporter.testEnd({
      title: tc.fullTitle,
      device,
      status: 'failed',
      durationMs: 0,
      retries: maxRetries,
      error: lastError?.message,
    });
    return {
      title: tc.fullTitle,
      status: 'failed',
      durationMs: 0,
      retries: maxRetries,
      device,
      error: lastError?.message,
      file: tc.file,
      runId: lastRunId,
    };
  }

  // ── scope teardown: afterAll for entered scopes, innermost first ──
  private async runAfterAll(
    device: Device,
    state: State,
    scopeState: WorkerScopeState
  ): Promise<void> {
    for (const sid of [...scopeState.entered].reverse()) {
      const scope = getScope(sid);
      if (!scope?.afterAll.length) continue;
      const app = new AppClaw(this.appOptions(device, `afterAll:${scope.title}`));
      const ctx: TestContext<State> = { state, title: scope.title, retry: 0, device };
      try {
        for (const h of scope.afterAll) await h(app, ctx);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`  afterAll "${scope.title}" failed: ${(err as Error).message}`);
      } finally {
        await app.teardown().catch(() => {});
      }
    }
  }

  private withTimeout<T>(p: T | Promise<T>, title: string): Promise<T> {
    const ms = this.config.timeout;
    if (!ms || ms <= 0) return Promise.resolve(p);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Test "${title}" timed out after ${ms}ms`)),
        ms
      );
      Promise.resolve(p).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  private appOptions(device: Device, reportName: string): AppClawOptions {
    const base = this.config.appOptions;
    return {
      // User-provided AppClaw options (provider, model, agentMode, maxSteps,
      // waitTimeout, video, capabilitiesFile, locatorCache, …) flow through.
      ...base,
      // Runner-managed — always overridden so the user can't break the SSE
      // node wiring, device pinning, or per-test report.
      mcpTransport: 'sse',
      mcpHost: this.nodeHost,
      mcpPort: this.nodePort,
      deviceUdid: device.udid,
      platform: this.config.platform,
      reportName,
      // Tag every test's manifest so the suite report can group + link them.
      reportDevice: device.name,
      reportSuiteId: this.suiteId,
      reportSuiteName: this.suiteName,
      // Sensible runner defaults, still overridable by the user's config.
      report: base.report ?? true,
      silent: base.silent ?? true,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────
  private summarize(results: TestResult[], durationMs: number): SuiteResult {
    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    return { results, passed, failed, skipped, allPassed: failed === 0, durationMs };
  }
}
