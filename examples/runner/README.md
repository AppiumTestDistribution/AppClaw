# AppClaw Runner — example

A minimal project showing the runner: one `appclaw.config.ts` (infra, written
once) and spec files under `tests/` (what test authors write).

## Layout

```
appclaw.config.ts     # nodes, concurrency, retries, llm, lifecycle hooks
tests/
  login.spec.ts         # test(...) / describe(...) — no UDIDs, no ports
  fixtures.ts           # test.extend(...) — loggedInApp, deviceLabel, apiUser
  fixtures-demo.spec.ts # consumes loggedInApp (test) + deviceLabel (worker)
  api-user.spec.ts      # reads device info + data returned from a fixture
  api.ts                # stand-in backend (createUser/deleteUser) for apiUser
  steps.ts              # shared step helpers (not collected as tests)
```

## Setup (running inside this repo)

This example imports the local `appclaw` package by its name (`appclaw/runner`),
so link the repo into it once:

```bash
# from the repo root — exposes the local build as a global `appclaw`
npm run build && npm link

# from this folder — symlink the linked package into node_modules
cd examples/runner && npm link appclaw
```

A real consumer project skips this and just runs `npm install -D appclaw tsx`.

## Run

The runner spawns a local appium-mcp in SSE mode, discovers connected
devices/emulators, and runs the specs across them in parallel.

Trigger it from `package.json` scripts — that's the normal entry point:

```jsonc
// package.json
{
  "scripts": {
    "test": "appclaw test", // runs everything in testDir
    "test:parallel": "appclaw test --workers 2",
    "test:login": "appclaw test tests/login.spec.ts",
    "test:grep": "appclaw test --grep login",
  },
  "devDependencies": { "appclaw": "^1.8.0", "tsx": "^4.21.0" },
}
```

```bash
# from this folder, with an Android emulator or device connected:
npm test                          # → appclaw test (reads appclaw.config.ts)
npm run test:parallel             # 2 devices at once
npm run test:login                # one file
```

`appclaw test` auto-discovers `appclaw.config.ts` in the working directory and
runs the specs in `testDir`. You can also call the binary directly
(`npx appclaw test ...`) with the same flags: `--workers`, `--retries`,
`--grep`, `--shard 1/2`, etc.

### Live view

On an interactive terminal the run renders a live dashboard — one lane per
device, a progress bar, pass/fail counts, and the queue depth:

```
╭ AppClaw Runner · android · 2 devices · 2 workers ──────── 0:18 ╮
│  ▓▓▓▓▓▓░░░░░░░░░░  2/5   ✓ 2  ✗ 0                              │
│                                                               │
│  ⠙ emulator-5554  slider shows two green dots             12s │
│  ⠹ emulator-5556  Login › click login                      7s │
│                                                               │
│  queue  ▣░░░░░░░░░  1 waiting                                  │
╰───────────────────────────────────────────────────────────────╯
```

Finished tests scroll above it and persist; a one-line summary is printed at
the end. For plain line-by-line output (or in CI — detected automatically) use
`--reporter plain` or `APPCLAW_TUI=off`.

### Run report (HTML)

Every run writes a **self-contained HTML report for that run only** (not a
history of past runs) and prints its path:

```
→ report  .appclaw/runs/suite-…/index.html
```

Open it in a browser. It includes a pass-rate summary, a per-device breakdown,
results grouped by spec file, and — expanding a test — the device-framed
screenshot of every step, the failure reason, and a screen recording when
captured. It's scoped to the current run, so it loads fast and isn't polluted by
earlier runs.

> The older `appclaw --report` viewer still indexes _all_ historical runs; this
> per-run report is the one printed at the end of `appclaw test`.

### Android & iOS

A run targets **one platform** — `platform` in the config, or `--platform
android|ios` to override. Specs don't change across platforms (AppClaw drives by
natural language + vision, not platform selectors), so the same `tests/` run on
both — only the config (platform + capabilities) differs.

The clean setup is two config files sharing one `tests/` folder, since
`capabilitiesFile` is per-platform:

```jsonc
// package.json
"scripts": {
  "test:android": "appclaw test -c appclaw.android.ts",
  "test:ios":     "appclaw test -c appclaw.ios.ts",
  "test:all":     "npm run test:android && npm run test:ios"
}
```

Each invocation discovers its own device pool and writes its own report under
`.appclaw/runs/`. There's no single-command Android+iOS matrix — in CI this maps
onto separate jobs (an Android runner and a Mac/iOS runner), each running its own
script against its own devices.

### Environment (.env)

The config reads keys from `process.env` (`LLM_PROVIDER`, `LLM_API_KEY`,
`LLM_MODEL`). A `.env` in the directory you run from is **auto-loaded** — in
your own project just drop `.env` next to `package.json`.

This example reuses the repo-root `.env`, so its scripts pass `--env-file`:

```bash
appclaw test --env-file ../../.env          # this example
appclaw test                                # your project (.env auto-loaded)
```

> Spec/config files are TypeScript. `appclaw test` registers a TS loader (`tsx`)
> automatically, so just keep `tsx` in your `devDependencies`. Pre-compiled
> `.js` specs run without it.

## What the runner handles for you

- spinning up the appium-mcp SSE server
- discovering the device pool and assigning one device per worker
- free driver ports per session (no port config in your tests)
- retries, sharding, timeouts, and a suite report under `.appclaw/runs/`

You only write the `test(...)` bodies.
