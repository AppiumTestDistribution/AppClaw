# AppClaw

AI-powered mobile automation agent — control Android & iOS devices from VS Code.

## Features

- **Device Preview Panel** — see the device screen and step execution log in a webview
- **Parallel Run Grid** — live multi-device grid for parallel/suite flows: per-device step log, progress bar, and pass/fail result per card
- **Goal Runner** — enter natural language goals from the command palette or device panel
- **Flow File CodeLens** — "Run Flow" / "Run Step" buttons on YAML flow files
- **Sidebar** — Devices, Flows, and History tree views
- **HITL Support** — respond to OTP/CAPTCHA prompts right in the webview
- **Re-run Failed** — after a suite, re-run only the failed flows with one click

## Getting Started

### Prerequisites

- [AppClaw CLI](https://www.npmjs.com/package/appclaw) installed globally or via npx
- Android SDK / Xcode (depending on target platform)
- A connected device or running emulator/simulator

### Quick Setup

1. Install the extension
2. Open VS Code Settings and search for `appclaw`
3. Set your **Agent Mode** (`vision` or `dom`)
4. Set your **LLM Provider** and API key
5. Connect a device or start an emulator
6. Open the command palette and run **AppClaw: Run Goal**

## Agent Modes

| Mode                     | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| **Vision** (recommended) | Screenshot-first — uses AI vision to locate elements         |
| **DOM**                  | XML page source — works with any LLM, no vision setup needed |

## Supported LLM Providers

- Gemini (recommended)
- Anthropic (Claude)
- OpenAI
- Groq
- Ollama (local)

## Commands

| Command                      | Description                       |
| ---------------------------- | --------------------------------- |
| `AppClaw: Run Goal`          | Enter a natural language goal     |
| `AppClaw: Run Flow File`     | Run the current YAML flow file    |
| `AppClaw: Run This Step`     | Run a single step from a flow     |
| `AppClaw: Open Device Panel` | Open the device preview panel     |
| `AppClaw: Start Playground`  | Interactive playground mode       |
| `AppClaw: Take Screenshot`   | Capture the current device screen |
| `AppClaw: Stop Execution`    | Stop the running agent            |

## Configuration

All settings are under `appclaw.*` in VS Code Settings.

See the [full documentation](https://github.com/AppiumTestDistribution/appclaw) for detailed configuration options.

## Architecture

```
Extension (VS Code)                 CLI (Node.js)
+-----------------+    spawns      +------------------+
|  extension.ts   |--------------->|  appclaw --json  |
|  bridge.ts      |   NDJSON       |                  |
|  device-panel   |<---------------|  json-emitter.ts |
|  codelens       |    stdout      |  agent loop      |
|  tree views     |                |  flow runner     |
+-----------------+                +------------------+
```

The extension spawns `appclaw --json` as a child process. The CLI emits newline-delimited JSON events on stdout.

## License

MIT
