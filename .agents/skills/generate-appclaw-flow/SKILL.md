---
name: generate-appclaw-flow
description: >
  Generate YAML flow files for AppClaw mobile automation. Handles structured steps,
  natural language steps, phased flows (setup/steps/assertions), variable and secret
  interpolation via .appclaw/env/, and validation. Trigger when the user wants to
  create, edit, or fix a YAML flow file for AppClaw.
---

# AppClaw Flow Generator

You are an expert mobile QA automation engineer with deep Appium experience across Android and iOS. Generate AppClaw YAML flow files with precision — these files drive real device automation without an LLM at runtime, so every step must map to an action the parser and executor can resolve.

## Core Principles

- **Test user-facing functionality only.** Flows automate what a human does on a phone: tap, type, swipe, scroll, navigate, verify visible text. No API calls, no backend logic.
- **Flows must be idempotent.** Assume the app may be in any state from a prior failed run. Use `setup` phases to reset to a known state.
- **Never hardcode secrets.** Use `${secrets.KEY}` for credentials and sensitive data. Use `${variables.KEY}` for non-sensitive config. Both resolve from `.appclaw/env/<name>.yaml`.
- **Prefer natural language steps** — they're more readable and the parser handles them well. Fall back to structured keys only when you need precise control (exact timeout, repeat count, scroll direction).

## Workflow

### Step 1 — Understand the Goal

Read the user's request. If they reference an app, understand:

- Target platform (Android, iOS, or both)
- App package/bundle ID (needed for `appId` in header)
- The user journey to automate
- What success looks like (what to assert)

### Step 2 — Check Existing Flows and Environment

Before writing anything:

1. Check `examples/flows/` and any user flow directories for existing flows that overlap.
2. Inspect `.appclaw/env/` for existing variable/secret bindings you can reuse.
3. If the flow needs credentials, check which `${secrets.*}` and `${variables.*}` are already declared.

### Step 3 — Propose a Plan

Present the user with:

- Flow file path and name
- Which format (flat vs phased) and why
- Steps you intend to include (summarized)
- Any new variables/secrets needed
- Any `.appclaw/env/*.yaml` changes required

**Do NOT write files until the user approves.**

### Step 4 — Generate the Flow

Write the YAML file following the exact syntax rules below. If new env bindings are needed, create or update `.appclaw/env/<name>.yaml` in the same change set.

### Step 5 — Validate

Run `npx tsx src/index.ts --flow <path>` in dry-run or read the parser output to confirm the flow parses without errors. If the user has a device connected, offer to run it.

---

## YAML Flow Formats

### Flat Format (simple flows)

A YAML two-document file: metadata header, then a list of steps.

```yaml
name: VodQA — login and vertical swiping demo
---
- open vodqa app
- wait 2 s
- Click on login button
- Click on Vertical Swiping
- swipe down
- done opened vertical swiping and swiped
```

### Phased Format (test scenarios)

Organize steps into `setup`, `steps`, and `assertions`. At least one section required.

```yaml
name: Login Test
description: Validates the login flow end to end
platform: ios
env: dev
---
setup:
  - open MyApp
  - wait until login screen is visible

steps:
  - type '${secrets.email}' in email field
  - type '${secrets.password}' in password field
  - tap Login button
  - wait 5s

assertions:
  - verify Dashboard is visible
  - verify Welcome is visible
```

### Parallel Format (same flow, N devices)

Add `parallel: N` to the metadata. The same flow runs on N devices simultaneously — useful for load/compatibility testing.

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

### Suite Format (different flows across N workers)

A suite YAML has a `flows:` list and optional `parallel: N`. Workers pick flows from a queue until all are done. If `parallel` is omitted, flows run sequentially on a single device.

```yaml
name: youtube_suite
platform: android
parallel: 2
flows:
  - flows/login.yaml
  - flows/search.yaml
  - flows/playback.yaml
```

Suite files use the **same `--flow` flag** as regular flows — the CLI detects the `flows:` key and routes to the suite runner.

### Natural Language Format (most readable)

Steps are plain English — the parser converts them to structured actions.

```yaml
name: YouTube search
---
- open YouTube app
- click on search icon
- type "Appium 3.0" in the search bar
- perform search
- scroll down 2 times until "TestMu AI" is visible
- verify video from TestMu AI is visible
- done
```

You can freely mix natural language and structured steps in the same flow.

---

## Metadata Header Fields

| Field         | Type               | Purpose                                                                                       |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `appId`       | string             | App package (Android) or bundle ID (iOS). Required for `launchApp` step                       |
| `name`        | string             | Flow name, shown in reports and logs                                                          |
| `description` | string             | Human-readable description                                                                    |
| `platform`    | `android` or `ios` | Target platform (optional — can be set at runtime)                                            |
| `env`         | string             | Environment name — resolves `.appclaw/env/<name>.yaml` for variable/secret bindings           |
| `parallel`    | number             | Run on N devices concurrently (single flow) or with N workers (suite). Omit for single-device |
| `flows`       | list of paths      | Suite mode — list of flow files to distribute across workers                                  |

---

## Structured Step Reference

Use these when you need precise control over parameters.

| Step            | Syntax                                                         | Notes                                                         |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `launchApp`     | `- launchApp`                                                  | Launches app by `appId` from header                           |
| `tap`           | `- tap: "Login Button"`                                        | Tap element matching label (DOM text, accessibility ID, hint) |
| `type`          | `- type: "hello"`                                              | Type into the currently focused field                         |
| `wait`          | `- wait: 3`                                                    | Sleep N seconds                                               |
| `waitUntil`     | `- waitUntil: "Login Button"`                                  | Wait for text to appear (default 10s timeout)                 |
| `waitUntil`     | `- { waitUntil: "text", timeout: 15 }`                         | Wait with custom timeout                                      |
| `waitUntilGone` | `- waitUntilGone: "Loading"`                                   | Wait for text to disappear                                    |
| `swipe`         | `- swipe: "up"`                                                | Swipe direction: up, down, left, right                        |
| `swipe`         | `- { swipe: "down", repeat: 3 }`                               | Swipe with repeat count                                       |
| `assert`        | `- assert: "Login Successful"`                                 | Verify text is visible on screen                              |
| `scrollAssert`  | `- { scrollAssert: "Item 5", direction: down, maxScrolls: 5 }` | Scroll until text found                                       |
| `enter`         | `- enter`                                                      | Press Enter/Return key                                        |
| `back`          | `- back` or `- goBack`                                         | Press Back button                                             |
| `home`          | `- home` or `- goHome`                                         | Press Home button                                             |
| `getInfo`       | `- getInfo: "What is the balance?"`                            | Ask a question about the screen (vision, returns answer)      |
| `done`          | `- done` or `- done: "Success message"`                        | End flow. With message: verifies text before succeeding       |

---

## Natural Language Patterns

The parser recognizes these patterns (case-insensitive). Use them for readability.

### App Launch

- `open YouTube app`, `launch Safari`, `start Settings`

### Tap / Click

- `tap Login button`, `click on Settings`, `press Submit`
- `toggle WiFi`, `enable Bluetooth`, `turn off Airplane Mode`
- `close dialog`, `dismiss popup`, `cancel alert`
- `navigate to Settings screen`

### Text Input

- `type "hello" in search field`, `type 'password123' in password field`
- `enter "hello world"`, `enter text "hello"`
- `search for "pizza"`, `search "restaurants"`

### Scrolling & Swiping

- `swipe up`, `swipe down 3 times`
- `scroll down`, `scroll up 2 times`
- `scroll down until "Submit" is visible`
- `scroll down 3 times until "Item" is visible`

### Waiting

- `wait 5 seconds`, `wait 2s`, `pause 500ms`
- `wait a moment`, `sleep 3 sec`
- `wait until screen is loaded` (DOM stability check)
- `wait until "Login Button" is visible`
- `wait 10s until "Dashboard" is visible`
- `wait until "Loading" is gone`

### Navigation

- `go back`, `press back`, `navigate back`
- `go home`, `press home`
- `press enter`, `hit enter`, `submit`, `perform search`

### Assertions

- `verify Dashboard is visible`
- `assert "Welcome!" is visible`
- `check that Login button is on the screen`

### Questions (Vision mode only)

- `what's on the screen?` — returns a description
- `how many items are there?` — answered via vision

---

## Variable & Secret Interpolation

### Syntax in Flow Steps

```yaml
- type '${variables.username}' in username field
- type '${secrets.password}' in password field
- verify ${variables.welcome_text} is visible
```

### Environment File (`.appclaw/env/<name>.yaml`)

```yaml
variables:
  app_name: youtube
  expected_channel: TestMu AI
  locale: en-US
  timeout: 30

secrets:
  email: '${TEST_USER_EMAIL}'
  password: '${TEST_USER_PASSWORD}'
```

**Rules:**

- `variables` — non-sensitive, literal values (string, number, boolean). Shown in logs.
- `secrets` — sensitive values. Use `"${SHELL_ENV_VAR}"` placeholders. Resolved from shell environment at runtime. Redacted in logs as `***`.
- Never hardcode actual secret values in YAML files.
- The user must `export TEST_USER_EMAIL=...` in their shell or `.env` before running.

### Referencing Environment

Set `env: dev` in the flow header to load `.appclaw/env/dev.yaml`:

```yaml
name: Login Test
env: dev
---
steps:
  - type '${secrets.email}' in email field
```

The parser walks up from the flow file directory looking for `.appclaw/env/<name>.yaml`.

---

## Writing Good Flows

### Be Specific About UI Elements

```yaml
# Bad — ambiguous
- tap button

# Good — names the visible label
- tap "Sign In" button
- tap "Connections"
- click on search icon
```

### Use Setup for Idempotency

If the test changes app state, the setup phase must handle prior state:

| Test validates... | Setup must...                      |
| ----------------- | ---------------------------------- |
| Adding an item    | Delete the item first if it exists |
| Enabling a toggle | Disable it first if already on     |
| Login flow        | Log out first if already logged in |
| Form submission   | Clear any pre-filled data          |

### Platform-Specific Flows

- Different Android OEMs have different UI labels (Samsung "Connections" vs Pixel "Network & internet").
- iOS simulators vs real devices may have different navigation patterns.
- Add comments in YAML documenting OEM-specific notes:

```yaml
# Samsung: Connections → Wi-Fi
# Pixel/AOSP: Network & internet → Internet → Wi-Fi
- tap: 'Connections'
```

### Vision Fallback

When the DOM can't match an element (custom views, canvas-rendered UI), the executor falls back to vision if configured (`AGENT_MODE=vision` or `VISION_MODE=fallback`). For flows targeting such apps:

- Use descriptive labels: `tap "red heart icon"` instead of `tap "icon"`
- Vision works best with unique, visually distinct descriptions

### Flow Length

- Keep flows focused on one user journey (5-20 steps).
- Use phased format for anything with setup/teardown needs.
- A `done` step is auto-appended if you omit it, but including it with a verification message is better practice.

---

## Strict YAML Rules

- **2-space indentation** (not tabs)
- **Quote strings** containing special YAML characters (`:`, `#`, `{`, `}`, `[`, `]`)
- **Single quotes** around interpolated values: `type '${secrets.email}'`
- **No markdown fences** in the actual file — write raw YAML
- **Comments** with `#` are preserved and useful for documenting OEM differences

---

## Coordination

- For **running flows** or **CLI usage help**, route to the `use-appclaw-cli` skill.
- For **debugging flow execution failures**, check the step error output — it includes which element matching failed and what was on screen.
