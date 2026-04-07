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
LLM_MODEL=gemini-3.1-flash-lite-preview
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
- Export to a YAML flow file anytime
- Slash commands: `/help`, `/steps`, `/export`, `/clear`, `/device`, `/disconnect`

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

| Variable              | Default  | Description                                                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------- |
| **Platform**          |          |                                                                                   |
| `PLATFORM`            | (prompt) | Target platform: `android` or `ios`                                               |
| `DEVICE_TYPE`         | (prompt) | iOS device type: `simulator` or `real`                                            |
| `DEVICE_UDID`         | (auto)   | Device UDID — skips device picker                                                 |
| `DEVICE_NAME`         | (auto)   | Device name — partial match (e.g. `iPhone 17 Pro`)                                |
| **LLM**               |          |                                                                                   |
| `LLM_PROVIDER`        | `gemini` | LLM provider (`anthropic`, `openai`, `gemini`, `groq`, `ollama`)                  |
| `LLM_API_KEY`         | —        | API key for your provider                                                         |
| `LLM_MODEL`           | (auto)   | Model override (e.g. `gemini-3.1-flash-lite-preview`, `claude-sonnet-4-20250514`) |
| `AGENT_MODE`          | `vision` | `dom` (XML locators) or `vision` (screenshot-first)                               |
| **Agent**             |          |                                                                                   |
| `MAX_STEPS`           | `30`     | Max steps per goal                                                                |
| `STEP_DELAY`          | `500`    | Milliseconds between steps                                                        |
| `LLM_THINKING`        | `off`    | Extended thinking/reasoning (`on` or `off`)                                       |
| `LLM_THINKING_BUDGET` | `1024`   | Token budget for extended thinking                                                |
| `SHOW_TOKEN_USAGE`    | `false`  | Print token usage and cost per step                                               |

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

## License

Licensed under the Apache License, Version 2.0. See `LICENSE` for the full text.
