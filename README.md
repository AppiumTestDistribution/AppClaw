<p align="center">
  <img src="landing/logo.svg" alt="AppClaw logo" width="120" height="120">
</p>

<h1 align="center">AppClaw</h1>

<p align="center">AI-powered mobile automation agent for Android and iOS. Tell it what to do in plain English — it figures out what to tap, type, and swipe.</p>

<table align="center">
<tr>
<td valign="middle" align="center">

<img src="landing/demo.gif" alt="AppClaw demo" width="280">

</td>
<td valign="middle">

```
You: "Send a WhatsApp message to Mom
      saying good morning"

AppClaw:
  Step 1: Open WhatsApp
  Step 2: Search for Mom
  Step 3: Open chat with Mom
  Step 4: Type "good morning"
  Step 5: Tap Send
  Step 6: Done

  ✅ Goal completed in 6 steps.
```

</td>
</tr>
</table>

## Prerequisites

1. **Node.js** 18+
2. **Device connected** — USB, emulator, or simulator
3. **LLM API key** from any supported provider (Anthropic, OpenAI, Google, Groq, or local Ollama)

## Installation

### From npm

```bash
npm install -g appclaw
```

Create a `.env` file in your working directory:

```bash
cp .env.example .env
```

### Local development

```bash
git clone https://github.com/AppiumTestDistribution/appclaw.git
cd appclaw
npm install
cp .env.example .env
```

Edit `.env` based on your preferred mode:

<details>
<summary><strong>Vision mode (recommended)</strong></summary>

Screenshot-first mode using Stark (df-vision + Gemini) for element location. Requires a Gemini API key.

```env
LLM_PROVIDER=gemini
LLM_API_KEY=your-gemini-api-key
LLM_MODEL=gemini-3.1-flash-lite
AGENT_MODE=vision
```

</details>

<details>
<summary><strong>DOM mode</strong></summary>

Uses XML page source to find elements by accessibility ID, xpath, etc. No vision needed — works with any LLM provider.

```env
LLM_PROVIDER=gemini            # or anthropic, openai, groq, ollama
LLM_API_KEY=your-api-key
AGENT_MODE=dom
```

</details>

## Usage

### Platform & device selection

AppClaw supports both Android and iOS (simulators + real devices). On macOS, you'll get an interactive prompt to choose. For CI or to skip prompts, use flags:

```bash
# Android (default — no flags needed)
appclaw "Open Settings"

# iOS Simulator (auto-selects the booted simulator)
appclaw --platform ios --device-type simulator "Open Settings"

# iOS Simulator — pick by name
appclaw --platform ios --device-type simulator --device "iPhone 17 Pro" "Open Settings"

# iOS Real Device — pick by UDID
appclaw --platform ios --device-type real --udid 00008120-XXXX "Open Settings"

# Env vars work too (great for .env or CI)
PLATFORM=ios DEVICE_TYPE=simulator appclaw "Open Settings"
```

> **Tip:** If only one simulator is booted, it's auto-selected — no `--udid` needed.

### Agent mode (LLM-driven)

```bash
# Interactive mode (prompts for platform + goal)
appclaw

# Pass goal directly
appclaw "Open Settings"
appclaw "Search for cats on YouTube"
appclaw "Turn on WiFi"
appclaw "Send hello on WhatsApp to Mom"

# Or with npx (no global install)
npx appclaw "Open Settings"
```

When running from a local clone, use `npm start` instead:

```bash
npm start
npm start "Open Settings"
```

**Export a replayable test** — pass `--export` and the agent's trajectory is written as a runnable vitest spec when the goal completes:

```bash
# Default path: $EXPORT_DIR/<goal-slug>.test.ts (defaults to .appclaw/exports/)
appclaw --export "Open YouTube and search for Appium 3.0"

# Bare filename → EXPORT_DIR/<name>
appclaw --export youtube.test.ts "Open YouTube and search for Appium 3.0"

# Path with directory hint → used verbatim
appclaw --export tests/e2e/youtube.test.ts "Open YouTube"

# Override the directory for one run
appclaw --export-dir tests/recorded --export youtube.test.ts "Open YouTube"

# Or set it persistently in .env
echo 'EXPORT_DIR=tests/recorded' >> .env
```

The export drops the wrong-direction branch when verification rejected a `done`, preserves the auto-launched app as the first step, and translates internal agent tools back to natural language so the generated test reads like English. See the [SDK section](#sdk-typescript--javascript) below for what the test file looks like.

### YAML flows (no LLM needed)

Run declarative automation steps from a YAML file — fast, repeatable, zero LLM cost:

```bash
appclaw --flow examples/flows/google-search.yaml
```

Flows support both structured and natural language syntax:

**Structured:**

```yaml
appId: com.android.settings
name: Turn on WiFi
---
- launchApp
- wait: 2
- tap: 'Connections'
- tap: 'Wi-Fi'
- done: 'Wi-Fi turned on'
```

**Natural language:**

```yaml
name: YouTube search
---
- open YouTube app
- click on search icon
- type "Appium 3.0" in the search bar
- perform search
- scroll down until "TestMu AI" is visible
- verify video from TestMu AI is visible
- done
```

Supported natural language patterns include: `open <app>`, `click/tap <element>`, `type "text"`, `scroll up/down`, `swipe left/right`, `scroll down until "X" is visible`, `wait N seconds`, `go back`, `press home`, `verify/assert <element> is visible`, `press enter`, and `done`. Questions like `"whats on the screen?"` or `"how many items are there?"` are answered via vision without executing any action.

### Parallel & suite runs

Run the same flow on N devices simultaneously, or distribute a suite of flows across N workers:

**Same flow, N devices** — add `parallel: N` to the flow's metadata:

```yaml
name: youtube_parallel
platform: android
parallel: 2
---
- open YouTube app
- search for "Appium 3.0"
- assert "TestMu AI" is visible
- done
```

```bash
appclaw --flow youtube.yaml   # spins up 2 devices, runs flow on both concurrently
```

**Suite: different flows, N workers** — a suite YAML lists flows and a worker count:

```yaml
name: youtube_suite
platform: android
parallel: 2
flows:
  - flows/login.yaml
  - flows/search.yaml
  - flows/playback.yaml
```

```bash
appclaw --flow youtube-suite.yaml   # 2 devices pull from queue until all 3 flows finish
```

The VS Code extension shows a **live multi-device grid** — each device card updates in real time with a per-device step log, progress bar, and pass/fail result. Failed flows can be re-run with **Re-run Failed** from the summary notification.

### Playground (interactive REPL)

Build YAML flows interactively on a real device — type commands and watch them execute live:

```bash
appclaw --playground

# iOS simulator
appclaw --playground --platform ios --device-type simulator

# Specific device
appclaw --playground --platform ios --device-type simulator --device "iPhone 17 Pro"
```

Features:

- Type natural-language commands that execute immediately on the device
- Steps accumulate as you go
- Export to a YAML flow file or a runnable SDK test (vitest spec) — format picked from the file extension
- Slash commands: `/help`, `/steps`, `/export`, `/clear`, `/device`, `/disconnect`

**Export formats** — `/export` dispatches by extension:

```
> /export my-flow.yaml              # YAML flow (default behaviour)
> /export tests/youtube.test.ts     # SDK vitest spec
> /export youtube.test.ts           # bare filename → EXPORT_DIR/youtube.test.ts
```

Bare filenames for SDK tests land in `EXPORT_DIR` (default `.appclaw/exports`); paths with a directory hint are used verbatim. YAML files stay in the current directory regardless.

### SDK (TypeScript / JavaScript)

Drive a device programmatically from a vitest / jest / mocha test. The SDK exposes the same natural-language layer as the playground, so steps you build interactively can be lifted into a test file as-is.

```ts
import { AppClaw, AppClawAssertionError } from 'appclaw';
import { describe, it } from 'vitest';
import 'dotenv/config';

describe('YouTube smoke', () => {
  it('searches and verifies a result', async () => {
    const app = new AppClaw({
      provider: 'gemini',
      apiKey: process.env.LLM_API_KEY,
      platform: 'android',
      agentMode: 'vision',
      video: true, // record screen, embed in report
      mcpDebug: false, // silence appium-mcp stderr noise
    });

    await app.run('open YouTube app');
    await app.run('tap search icon');
    await app.run('type "Appium 3.0"');
    await app.run('tap first result');

    // Throws AppClawAssertionError on failure — vitest marks the test red.
    // The error message includes the original claim, the LLM's reason (in
    // vision mode), and a snapshot of visible texts (in DOM mode).
    await app.verify('the video by TestMu AI is visible');

    await app.teardown(); // closes the appium session, writes the report
  }, 120_000);
});
```

**Three execution surfaces:**

| Method                           | Use when                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.run(instruction, options?)` | One natural-language step. Returns `{ success, action, message }` — does NOT throw on failure. `options` overrides wait/scroll config for this call only. |
| `app.verify(claim)`              | Assertion. Throws `AppClawAssertionError` so the test framework records a failure.                                                                        |
| `app.runFlow(path)`              | Execute a YAML flow file end-to-end.                                                                                                                      |
| `app.runGoal(goal, opts?)`       | Hand the goal to the LLM agent (same as CLI agent mode). Supports `exportPath` (see below).                                                               |

**Recording goal runs as replayable tests** — pass `exportPath` to `runGoal()` and the agent's trajectory is written as a runnable vitest spec when it finishes:

```ts
await app.runGoal('open YouTube, search for Appium 3.0, play first result', {
  exportPath: 'tests/e2e/youtube.test.ts',
});
```

The exported file replays via `app.run(...)` calls — no LLM cost, no agent loop. The exporter:

- Prepends the synthetic `launch_app` step the preprocessor handled (so the launch isn't missing from the replay)
- Drops the entire branch before a rejected `done` decision — the recovery path the agent took after a verification failure is the only one preserved
- Translates internal agent tools (`find_and_click`, `find_and_type`, etc.) back into natural language so the test reads like English

Read the four caveats embedded in the generated file header before running it in CI — replays don't inherit the agent's safety net.

**Per-command overrides** — `app.run()` takes an optional second argument that wins over the instance defaults for that one step. Useful for a slow screen that needs a longer wait, or a tight list that needs a shorter scroll:

```ts
// Wait up to 20s for this specific (slow-loading) screen
await app.run('click on Dashboard', { waitTimeout: 20000 });

// Scroll a short distance, up to 5 times, to find an item
await app.run('scroll down until Karma is visible', { scrollMode: 'short', scrollTimes: 5 });

// A single full-screen swipe
await app.run('swipe up', { scrollMode: 'full' });
```

| `RunOptions` field | Purpose                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `waitTimeout`      | Implicit-wait timeout (ms) for this command's target element. Overrides instance value. |
| `waitInterval`     | Poll cadence (ms) for this command's implicit wait.                                     |
| `scrollMode`       | Scroll/swipe distance: `short` (~30%) / `medium` (~60%) / `full` (~90%) of the screen.  |
| `scrollTimes`      | Repeat count (plain swipe) or max scroll attempts (`scroll … until …`).                 |

`scrollMode` / `scrollTimes` can also be set on the constructor as instance-wide defaults.

**Constructor options** (all optional — env vars fall through):

| Option         | Default       | Purpose                                                                                                                                             |
| -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`     | `gemini`      | LLM provider (`anthropic` / `openai` / `gemini` / `groq` / `ollama`)                                                                                |
| `apiKey`       | env           | API key for the chosen provider                                                                                                                     |
| `model`        | (auto)        | Model ID override                                                                                                                                   |
| `platform`     | `android`     | Target platform                                                                                                                                     |
| `deviceUdid`   | (auto)        | Pin to a specific device — required when running tests in parallel                                                                                  |
| `agentMode`    | `dom`         | `dom` or `vision` — vision-mode `verify()` failures include the LLM's reason                                                                        |
| `waitTimeout`  | `10000`       | Implicit wait (ms) — each action polls until its target is on screen before acting, so you don't need `wait …` steps between calls. `0` = fail-fast |
| `waitInterval` | `300`         | Poll cadence (ms) for `waitTimeout`                                                                                                                 |
| `scrollMode`   | (engine ~60%) | Default scroll/swipe distance: `short` / `medium` / `full`. Override per call via `run()`                                                           |
| `scrollTimes`  | (parsed)      | Default scroll/swipe repeat / max-scroll count. Override per call via `run()`                                                                       |
| `video`        | `false`       | Record screen and embed in the auto-generated report                                                                                                |
| `report`       | `true`        | Write an HTML report to `.appclaw/runs/` on teardown                                                                                                |
| `mcpDebug`     | env / `false` | Stream `[appium-mcp]` subprocess logs. Overrides `MCP_DEBUG=1`                                                                                      |
| `silent`       | `false`       | Suppress the per-step `✓ #N tap "label"` log lines. Default off — SDK consumers see device activity to match the playground UX.                     |

**TypeScript types** — the package ships full type declarations (`package.json` → `types: dist/sdk/index.d.ts`), so editors give autocomplete on every option and `tsc` rejects typos before a test runs. The public types are importable by name:

```ts
import { AppClaw, AppClawStepError, AppClawAssertionError } from 'appclaw';
import type { AppClawOptions, RunOptions, ScrollDistance, RunResult, FlowResult } from 'appclaw';
```

Definitions:

```ts
/** How far each scroll/swipe travels, as a fraction of the screen. */
type ScrollDistance = 'short' | 'medium' | 'full'; // ~30% / ~60% / ~90%

/** Constructor config — every field optional; unset falls back to env / defaults. */
interface AppClawOptions {
  provider?: 'anthropic' | 'openai' | 'gemini' | 'groq' | 'ollama';
  apiKey?: string;
  model?: string;
  platform?: 'android' | 'ios';
  deviceUdid?: string;
  agentMode?: 'dom' | 'vision';
  maxSteps?: number;
  stepDelay?: number;
  waitTimeout?: number; // implicit-wait timeout (ms), default 10000
  waitInterval?: number; // poll cadence (ms), default 300
  scrollMode?: ScrollDistance;
  scrollTimes?: number;
  silent?: boolean;
  failOnError?: boolean;
  report?: boolean;
  reportName?: string;
  video?: boolean;
  mcpTransport?: 'stdio' | 'sse';
  mcpHost?: string;
  mcpPort?: number;
  mcpDebug?: boolean;
}

/** Per-command overrides — the optional 2nd arg to `app.run()`. */
interface RunOptions {
  waitTimeout?: number;
  waitInterval?: number;
  scrollMode?: ScrollDistance;
  scrollTimes?: number;
}

/** Returned by `app.run()`. */
interface RunResult {
  success: boolean;
  action: string; // resolved step kind: tap | type | openApp | swipe | …
  message: string;
}
```

Because `RunOptions` is an `interface`, TypeScript's excess-property check flags a misspelled key (`waitTimout`) and the `ScrollDistance` union rejects an invalid value (`'shrt'`) with a "Did you mean …?" hint — so the options object is fully type-checked, not just `any`:

```ts
await app.run('swipe up', { scrollMode: 'shrt' }); // ✗ TS error: not assignable to ScrollDistance
await app.run('swipe up', { waitTimout: 1000 }); // ✗ TS error: unknown property (did you mean waitTimeout?)
```

> Inside this repo, import from the relative source path (`../src/sdk`) instead of `'appclaw'`.

### Explorer (PRD-driven test generation)

Generate YAML test flows from a PRD or app description — the explorer analyzes the document, optionally crawls the app on-device, and outputs ready-to-run flows:

```bash
# From a text description
appclaw --explore "YouTube app with search and playback" --num-flows 5

# From a PRD file, skip device crawling
appclaw --explore prd.txt --num-flows 3 --no-crawl

# Full options
appclaw --explore "Settings app" --num-flows 10 --output-dir my-flows --max-screens 15 --max-depth 4
```

### Record & replay

```bash
# Record a goal execution
appclaw --record "Open Settings"

# Replay a recording (adaptive — reads screen, not coordinates)
appclaw --replay logs/recording-xyz.json
```

### Goal decomposition

```bash
# Break complex multi-app goals into sub-goals
appclaw --plan "Copy the weather and send it on Slack"
```

## Configuration

All configuration is via `.env`:

| Variable              | Default            | Description                                                                                                                                                              |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Platform**          |                    |                                                                                                                                                                          |
| `PLATFORM`            | (prompt)           | Target platform: `android` or `ios`                                                                                                                                      |
| `DEVICE_TYPE`         | (prompt)           | iOS device type: `simulator` or `real`                                                                                                                                   |
| `DEVICE_UDID`         | (auto)             | Device UDID — skips device picker                                                                                                                                        |
| `DEVICE_NAME`         | (auto)             | Device name — partial match (e.g. `iPhone 17 Pro`)                                                                                                                       |
| **LLM**               |                    |                                                                                                                                                                          |
| `LLM_PROVIDER`        | `gemini`           | LLM provider (`anthropic`, `openai`, `gemini`, `groq`, `ollama`)                                                                                                         |
| `LLM_API_KEY`         | —                  | API key for your provider (not used for local Ollama; see `OLLAMA_*` for cloud URL / auth)                                                                               |
| `LLM_MODEL`           | (auto)             | Model override (e.g. `gemini-3.1-flash-lite`, `claude-sonnet-4-20250514`)                                                                                                |
| `OLLAMA_BASE_URL`     | (default)          | Ollama API base URL (e.g. remote or Docker). Empty = `http://127.0.0.1:11434` (`LLM_PROVIDER=ollama`)                                                                    |
| `OLLAMA_API_KEY`      | —                  | Optional Bearer token for Ollama Cloud or authenticated endpoints (`LLM_PROVIDER=ollama`)                                                                                |
| `AGENT_MODE`          | `vision`           | `dom` (XML locators) or `vision` (screenshot-first)                                                                                                                      |
| **Agent**             |                    |                                                                                                                                                                          |
| `MAX_STEPS`           | `30`               | Max steps per goal                                                                                                                                                       |
| `STEP_DELAY`          | `500`              | Milliseconds between steps                                                                                                                                               |
| `WAIT_TIMEOUT`        | `10000`            | Implicit wait (ms) for an element to be ready before each SDK action; `0` disables (fail-fast)                                                                           |
| `WAIT_INTERVAL`       | `300`              | Poll cadence (ms) for `WAIT_TIMEOUT`                                                                                                                                     |
| `LLM_THINKING`        | `off`              | Extended thinking/reasoning (`on` or `off`)                                                                                                                              |
| `LLM_THINKING_BUDGET` | `1024`             | Token budget for extended thinking                                                                                                                                       |
| `SHOW_TOKEN_USAGE`    | `false`            | Print token usage and cost per step                                                                                                                                      |
| **Output**            |                    |                                                                                                                                                                          |
| `EXPORT_DIR`          | `.appclaw/exports` | Default directory for `--export` and `/export *.test.ts`. Bare filenames land here; paths with a directory hint are used verbatim. Override per-run with `--export-dir`. |
| `MCP_DEBUG`           | `0`                | Stream verbose `[appium-mcp]` subprocess logs and per-tool timing. SDK can override via `mcpDebug` option.                                                               |

## How It Works

Each step, AppClaw:

1. **Perceives** — reads the device screen (UI elements or screenshot)
2. **Reasons** — sends the goal + screen state to an LLM, which decides the next action
3. **Acts** — executes the action (tap, type, swipe, launch app, etc.)
4. **Repeats** until the goal is complete or max steps reached

### Agent Actions

| Action                      | Description                         |
| --------------------------- | ----------------------------------- |
| `tap`                       | Tap an element                      |
| `type`                      | Type text into an input             |
| `scroll` / `swipe`          | Scroll or swipe gesture             |
| `launch`                    | Open an app                         |
| `back` / `home`             | Navigation buttons                  |
| `long_press` / `double_tap` | Touch gestures                      |
| `find_and_tap`              | Scroll to find, then tap            |
| `ask_user`                  | Pause for user input (OTP, CAPTCHA) |
| `done`                      | Goal complete                       |

### Failure Recovery

| Mechanism             | What it does                                             |
| --------------------- | -------------------------------------------------------- |
| **Stuck detection**   | Detects repeated screens/actions, injects recovery hints |
| **Checkpointing**     | Saves known-good states for rollback                     |
| **Human-in-the-loop** | Pauses for OTP, CAPTCHA, or ambiguous choices            |
| **Action retry**      | Feeds failures back to the LLM for re-planning           |

## CLI Reference

```
Usage: appclaw [options] [goal]

Platform & Device:
  --platform <android|ios>        Target platform (default: prompt on macOS, android elsewhere)
  --device-type <simulator|real>  iOS device type (default: prompt when --platform ios)
  --device <name>                 Device by name, partial match (e.g. "iPhone 17 Pro")
  --udid <udid>                   Device by UDID (skips device picker)

Modes:
  --flow <file.yaml>              Run declarative YAML steps (no LLM needed)
  --playground                    Interactive REPL to build YAML flows
  --explore <prd>                 Generate test flows from a PRD or description
  --record                        Record goal execution for replay
  --replay <file>                 Replay a recorded session

Export:
  --export [path]                 Write a replayable vitest spec after a goal run
                                  Empty: $EXPORT_DIR/<goal-slug>.test.ts
                                  Bare filename: $EXPORT_DIR/<name>
                                  Path with slash: used verbatim
  --export-dir <dir>              Override EXPORT_DIR for this run

Explorer:
  --num-flows <N>                 Number of flows to generate (default: 5)
  --no-crawl                      Skip device crawling (PRD-only generation)
  --output-dir <dir>              Output directory for generated flows
  --max-screens <N>               Max screens to crawl (default: 10)
  --max-depth <N>                 Max navigation depth (default: 3)

Environment variables (CI-friendly):
  PLATFORM          android | ios
  DEVICE_TYPE       simulator | real
  DEVICE_UDID       Device UDID
  DEVICE_NAME       Device name
  EXPORT_DIR        Default dir for --export bare filenames (.appclaw/exports)
```

## AI Agent Skills

If you're using **Claude Code**, **Codex**, or another tool that supports [skills](https://github.com/vercel-labs/skills), add the AppClaw skills to get expert help writing YAML flows and using the CLI:

```sh
npx skills add AppiumTestDistribution/appclaw
```

This installs two skills:

| Skill                   | What it does                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `generate-appclaw-flow` | Generates YAML flow files — knows the exact step syntax, natural language patterns, phased formats, and variable interpolation |
| `use-appclaw-cli`       | Helps run flows, configure `.env`, set up devices, choose vision providers, and troubleshoot                                   |

Skills are auto-discovered if you're working inside a clone of this repo.

## Agent-Driven Device CLI

For Claude Code, Gemini CLI, Codex CLI, and other agents that can run terminal
commands, install the separate agent-native CLI:

```sh
npm install -g appclaw-agent
appclaw-agent help workflow
```

`appclaw-agent` maintains named device sessions across commands and returns
compact UI references for deterministic interaction:

```sh
appclaw-agent --session login open com.example.app --platform android
appclaw-agent --session login snapshot -i --json
appclaw-agent --session login press @e1 --json
appclaw-agent --session login close
```

Install the `use-appclaw-agent-cli` skill to teach a supported agent this
workflow. Vision operations are available explicitly through `--vision` when
AppClaw vision is configured.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE` for the full text.
