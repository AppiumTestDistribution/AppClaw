# AppClaw Runner — Architecture

The runner owns the whole mobile test run: device pool, parallel sessions,
lifecycle hooks, and reporting. Test authors only write `test(...)` bodies;
everything else (nodes, ports, device assignment) is handled for them.

- **Step 1 (built):** local single-host — the runner spawns one local
  appium-mcp in SSE mode and fans out across the connected devices.
- **Step 2 (planned):** remote multi-node — the runner connects to appium-mcp
  SSE servers on other machines and pools devices across all of them.

---

## 1. Component layers

```
┌──────────────────────────────────────────────────────────────────────┐
│  Surfaces                                                              │
│    appclaw test (CLI)   ·   new Runner(cfg) (programmatic)            │
├──────────────────────────────────────────────────────────────────────┤
│  Collection            registry.ts   test() / describe() / .only/.skip │
│  Config                config.ts      defineConfig, resolve precedence │
├──────────────────────────────────────────────────────────────────────┤
│  Orchestration         runner.ts      scheduler · retries · lifecycle  │
├──────────────────────────────────────────────────────────────────────┤
│  Pool                  pool.ts        discover + dedup devices         │
│  Node                  node-local.ts  spawn/connect appium-mcp (SSE)   │
├──────────────────────────────────────────────────────────────────────┤
│  Session (per test)    sdk/AppClaw    create_session · run/verify ·    │
│                                       teardown (delete session)        │
├──────────────────────────────────────────────────────────────────────┤
│  Report                report.ts      suite entry + console summary    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Local single-host flow (step 1, current)

```
$ appclaw test [filter] [--workers N] [--retries N] ...
        │
        ▼
┌─ CLI  (cli.ts) ────────────────────────────────────────────────────────────┐
│ 1. findConfigFile() ───────► appclaw.config.ts                              │
│ 2. resolveConfig(file, cli)   precedence:  CLI flag > config > default      │
│ 3. discoverSpecs(testDir) ─►  [ login.spec.ts, cart.spec.ts, ... ]          │
│ 4. import each spec  ──────►  test()/describe() register into the registry  │
│ 5. collectTests()  ────────►  [ TestCase, ... ]   (.only/.skip applied)     │
└────────────────────────────────────────────────────────────────────────────┘
        │  new Runner(config).run(cases)
        ▼
┌─ Runner.run()  (runner.ts) ────────────────────────────────────────────────┐
│  connectNode()                                                             │
│    └─ startLocalSSENode() ─► spawn  appium-mcp --httpStream --port=<free>   │
│                              wait until /sse reachable          ▲ ownsNode  │
│                                                                 │ (stop at  │
│  discoverPool(node, platform)                                   │  the end) │
│    └─ select_device {platform} (list-only) ─► dedup by udid ─►  │           │
│         pool = [ device A, device B, ... ]                      │           │
│                                                                 │           │
│  state = globalSetup({ pool, config })   ◄── once, control plane            │
│                                                                             │
│  ── dispatch: work-queue, sticky device per worker ──                       │
│     workers = min(concurrency, pool.length)                                 │
│     queue: [ t1, t2, t3, t4, t5, ... ]                                      │
│       │              │                                                      │
│   ┌───▼─────────┐ ┌──▼──────────┐                                           │
│   │ worker 0    │ │ worker 1    │  ...  pull next test when free            │
│   │ device A    │ │ device B    │                                           │
│   └───┬─────────┘ └──┬──────────┘                                           │
└───────┼──────────────┼──────────────────────────────────────────────────── ┘
        ▼  (per test — runOne, retries + timeout)
┌─ runOne(testCase, device) ─────────────────────────────────────────────────┐
│  for attempt in 0..retries:                                                 │
│    app = new AppClaw({ mcpTransport:'sse', mcpHost, mcpPort,                 │
│                        deviceUdid: device.udid, platform, ...llm })         │
│       └─ McpSession.connect()                                               │
│            ├─ acquireSharedMCPClient(sse:host:port)  ── shared, ref-counted  │
│            ├─ buildParallelCaps() ► free systemPort / mjpegServerPort        │
│            ├─ pin appium:udid                                               │
│            └─ create_session ─► appium-mcp ─► device  (own sessionId)        │
│                                                                             │
│    if first test on this device:  deviceSetup(app, ctx)   ◄── once/device   │
│    beforeEach(app, ctx)                                                      │
│    testFn(app, ctx)  ─►  app.run('open Settings') / app.verify(...)          │
│    afterEach(app, info)                                                      │
│                                                                             │
│    app.teardown()                                                           │
│       └─ McpSession.release()                                               │
│            ├─ session_management DELETE sessionId ◄─ frees adb forwards +    │
│            │                                        on-device server         │
│            └─ handle.release()  (closes shared conn when refCount → 0)       │
│                                                                             │
│    pass ► ✓ return   |   fail & attempts left ► retry (fresh app)            │
└────────────────────────────────────────────────────────────────────────────┘
        │  (all workers drain the queue)
        ▼
┌─ Runner.run() — finalize ──────────────────────────────────────────────────┐
│   globalTeardown({ state, config })       ◄── once                          │
│   writeSuiteReport() + printSummary()     ─► .appclaw/runs/ , console table  │
│   finally:  if ownsNode ► node.stop()     ─► SIGTERM the appium-mcp          │
└────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
   exit 0 (allPassed) / 1
```

---

## 3. Remote multi-node topology (step 2, planned)

The only change is the **Node** layer: instead of spawning one local
appium-mcp, the runner connects to several SSE servers — each on its own
machine, each exposing its locally-connected devices. The pool is the **union**
across all nodes; the scheduler treats `(node, device)` as a slot and honors
per-test platform/OS tags.

```
                       ┌──────────────────────────────────────────────┐
   appclaw test  ───►  │         AppClaw Runner (control plane)         │
   *.spec.ts           │  registry · scheduler · lease · report agg.    │
                       └───┬───────────────┬───────────────┬───────────┘
                      SSE  │          SSE  │          SSE  │
              ┌────────────▼───┐  ┌────────▼───────┐  ┌────▼───────────┐
              │ Node A (macOS) │  │ Node B (Linux) │  │ Node C (macOS) │
              │ appium-mcp:8100│  │ appium-mcp:8100│  │ appium-mcp:8100│
              │ iPhone, iPad   │  │ Pixel, emu×3   │  │ iOS sims ×4    │
              └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
        session A1 ───┤            B1 ─────┤            C1 ─────┤
        session A2 ───┘            B2 ─────┘            C2 ─────┘

   global pool = A.devices ∪ B.devices ∪ C.devices   (dedup by udid)
   slot        = (node, device)        scheduler assigns one per worker
```

### What changes local → remote

| Concern            | Local (step 1)                                            | Remote (step 2)                                                                         |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Node               | runner spawns appium-mcp, `ownsNode=true`                 | connect to `node.url`, `ownsNode=false` (never killed)                                  |
| Free ports         | **runner picks them** (same host) via `buildParallelCaps` | **must be picked node-side** — the control plane can't probe a remote host's free ports |
| Discovery          | one `select_device` call                                  | one per node, merged + deduped                                                          |
| Crash blast radius | one process                                               | per-node; one node down ≠ whole run down                                                |

> **The remote port blocker:** in local mode AppClaw allocates real free ports
> and passes them in the caps. Across the wire it can't. This is exactly the
> appium-mcp change tracked in
> [`docs/appium-mcp-port-allocation-issue.md`](./appium-mcp-port-allocation-issue.md):
> when a port cap is unset, allocate it **node-side** before the driver starts.
> Until then, remote nodes would fall back to UiAutomator2/XCUITest fixed
> defaults (8200/8100/7810) and collide under parallelism.

---

## 4. Per-session capabilities (what reaches `create_session`)

```
{
  // appium-mcp built-in defaults
  "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:deviceName": "Android Device",
  "appium:settings[...]": 0,
  "appium:autoGrantPermissions": true,
  "appium:newCommandTimeout": 300,

  // injected by AppClaw / the runner — the parallel-safety bits
  "appium:systemPort": 53332,                       // free port (local-allocated)
  "appium:mjpegServerPort": 53333,                  // free port (local-allocated)
  "appium:mjpegScreenshotUrl": "http://127.0.0.1:53333",
  "appium:udid": "emulator-5554"                    // pinned device
}
```

`systemPort` + `mjpegServerPort` (unique per session) and `udid` (pinned) are
what let two concurrent sessions on one node never collide. iOS sends
`appium:wdaLocalPort` (+ per-udid `derivedDataPath` for parallel real devices)
instead of `systemPort`/`mjpeg`.

Merge order (later wins): `appium-mcp defaults` < `CAPABILITIES_FILE` <
`extraCaps` (ports + udid). Assembled in `sdk/mcp-session.ts` →
`device/session.ts:createPlatformSession`.

---

## 5. Lifecycle & cleanup

| Scope                               | Starts                                             | Ends                                           | Owns                                       |
| ----------------------------------- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| **Node**                            | `run()` start (local spawn / remote connect)       | `run()` `finally` (SIGTERM, local only)        | the appium-mcp server                      |
| **globalSetup state**               | once, after pool discovery                         | `globalTeardown`, once                         | shared run state (auth token, seeded data) |
| **device** (worker)                 | first test on that device (`deviceSetup`)          | end of run                                     | one leased device, reused across its tests |
| **scope** (`beforeAll`/`afterAll`)  | first test of a file/`describe` **on that device** | that device drains its queue (innermost-first) | per-(scope, device) setup                  |
| **test** (`beforeEach`/`afterEach`) | every test                                         | every test                                     | per-test                                   |
| **session** (per test)              | `app` construct → `create_session`                 | `app.teardown()` → `DELETE sessionId`          | one Appium session + its adb forwards      |

Ordering on a device: `deviceSetup` → `beforeAll` (file → describe…) → `beforeEach`
→ test → `afterEach` → … → `afterAll` (describe → file, reverse).

> **`beforeAll`/`afterAll` are once per _(scope, device)_, not once globally.**
> Every device that runs tests from a file/`describe` gets that scope's
> `beforeAll` before its first such test and `afterAll` when it finishes its
> queue. This preserves per-test parallelism (a file's tests can spread across
> devices). Because tests from different files can interleave on one device,
> `afterAll` runs at **worker drain** (innermost scope first), not the instant a
> `describe` block's last test ends. Use it for device/run-level setup
> (seed/clean data, start/stop a service), not for "immediately after this
> block" timing — that needs file-pinned scheduling (a future option).

Cleanup is layered: each test's `teardown()` deletes its session (freeing the
adb forwards for `systemPort`/`mjpegServerPort` and the on-device server); the
whole appium-mcp stops once at the end.

**Known gap:** the `finally` only fires on a normal return or a thrown error —
**not** on a hard interrupt (Ctrl-C, `kill -9`, `process.exit` mid-run). Those
orphan the local appium-mcp (and any open sessions). A signal/exit guard in the
runner (`SIGINT`/`SIGTERM`/`beforeExit` → `node.stop()` + delete open sessions)
closes it.

---

## 6. File map

| File                       | Responsibility                                              |
| -------------------------- | ----------------------------------------------------------- |
| `src/runner/cli.ts`        | `appclaw test` — arg parse, spec discovery, run, exit code  |
| `src/runner/config.ts`     | `defineConfig`, config-file load, CLI-override precedence   |
| `src/runner/registry.ts`   | `test` / `describe` / `.only` / `.skip` collection          |
| `src/runner/node-local.ts` | spawn `appium-mcp --httpStream`, health-check, stop         |
| `src/runner/pool.ts`       | discover devices over SSE, dedup by udid                    |
| `src/runner/runner.ts`     | scheduler, retries, timeout, lifecycle hooks                |
| `src/runner/report.ts`     | suite report + console summary                              |
| `src/runner/types.ts`      | config, lifecycle, test/result types                        |
| `src/sdk/mcp-session.ts`   | per-session connect (ports/udid) + release (delete session) |
| `src/device/session.ts`    | `createPlatformSession` — capability assembly               |

```

```
