# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is AppClaw?

AppClaw is an agentic AI layer for mobile automation (Android & iOS). Users describe goals in plain English and AppClaw orchestrates device interactions through appium-mcp (Model Context Protocol). It supports multiple LLM providers (Anthropic, OpenAI, Google Gemini, Groq, Ollama) via the Vercel AI SDK.

## Build & Run Commands

```bash
npm run build          # TypeScript compilation (tsc) → dist/
npm run typecheck      # Type-check without emitting
npm start              # Run via tsx (dev mode)
npm start "goal"       # Run with a goal argument
npm run dev            # Run with file watching
npx tsx tests/verify-parsing.ts  # Run parsing verification tests
```

No formal test framework (Jest/Vitest) is configured. Tests are ad-hoc scripts in `tests/`.

## Architecture

### Entry Point & CLI Modes (`src/index.ts`)

The CLI routes to 6 modes based on flags:

- **Interactive** (default) — prompts for platform/device/goal, runs agent loop
- **YAML Flow** (`--flow file.yaml`) — declarative automation, zero LLM cost
- **Playground** (`--playground`) — interactive REPL for building flows
- **Explorer** (`--explore`) — PRD → YAML test flow generation
- **Record/Replay** (`--record`, `--replay`) — capture and replay sessions
- **Report** (`--report`) — Express server serving HTML reports from `.appclaw/runs/`

The interactive and goal-direct paths also accept `--export [path]` (optionally `--export-dir <dir>`) to write a replayable vitest spec when the goal completes. Path resolution: empty → `EXPORT_DIR/<goal-slug>.test.ts`; bare filename → `EXPORT_DIR/<name>`; anything with a directory hint → used verbatim. Implementation in `src/sdk/goal-export.ts` (translator + renderer) called from `src/index.ts` after the agent loop.

### SDK (`src/sdk/`)

Public TypeScript API consumed by external tests (vitest/jest/mocha). Single entry: `import { AppClaw } from 'appclaw'`. Surface:

- `app.run(instruction, options?)` — one natural-language step, non-throwing, returns `{ success, action, message }`. `options` (`RunOptions`) applies per-command overrides for this call only: `waitTimeout`/`waitInterval` (implicit-wait poll budget) and `scrollMode`/`scrollTimes` (scroll/swipe distance + count). Instance-wide defaults for all four live on `AppClawOptions`; per-call values win. Implicit wait: every element-bearing action polls its target until present (DOM re-reads page source, vision re-captures the screenshot) or the budget is exhausted — `WAIT_TIMEOUT`/`WAIT_INTERVAL` env, default 10s/300ms
- `app.verify(claim)` — assertion. Throws `AppClawAssertionError` on failure (includes `claim`, `result`, and `screenContents` from DOM page-source in DOM mode — in vision mode the LLM's reason is already in `result.message`)
- `app.runFlow(path)` — wraps the YAML flow engine
- `app.runGoal(goal, { exportPath?, exportConfig? })` — wraps the agent loop. When `exportPath` is set, the trajectory is filtered with `keepOnlyFinalAttempt()` (drops the branch before any rejected `done`) then rendered as a vitest spec via `generateSdkTest()`
- `app.teardown()` — finalize report, close MCP

Helpers in `src/sdk/goal-export.ts`: `keepOnlyFinalAttempt`, `instructionsFromHistory`, `decisionToInstruction`, `generateSdkTest`, `generateSdkTestFromInstructions` (the last is used by the playground's `/export *.test.ts`).

### Core Agent Loop (`src/agent/loop.ts`)

The main Perception→Reasoning→Action loop:

1. **Perceive** — get screen state (DOM XML or screenshot) via `src/perception/`
2. **Reason** — send trimmed DOM + goal + history to LLM via `src/llm/`
3. **Act** — execute action (tap, type, swipe) via appium-mcp through `src/mcp/`
4. **Feedback** — check for stuck state (`src/agent/stuck.ts`), adapt if needed
5. **Loop** until goal complete or max steps reached

Supporting agent modules: planner (goal decomposition), recovery (checkpointing), human-in-the-loop (OTP/CAPTCHA pauses), episodic memory (trajectory reuse).

### Key Module Responsibilities

- **`src/sdk/`** — Public TypeScript API for external tests. `index.ts` is the `AppClaw` class; `goal-export.ts` translates agent histories back to natural-language `app.run(...)` calls and renders vitest specs; `step-runner.ts` adapts the YAML flow engine to single-instruction calls; `screen-snapshot.ts` captures visible DOM text for assertion-error context.
- **`src/llm/`** — Multi-provider LLM integration. `provider.ts` is the factory; `prompts.ts` builds system/user messages; `schemas.ts` defines action schemas. Tools from appium-mcp are dynamically converted to Vercel AI SDK format.
- **`src/mcp/`** — Appium MCP client wrapper. Connects via stdio (subprocess) or SSE. Handles tool calling, element finding, screenshots, keyboard input.
- **`src/perception/`** — Screen parsing. Android (`android-parser.ts`) and iOS (`ios-parser.ts`) XML parsers. `dom-trimmer.ts` compacts DOM for LLM token efficiency.
- **`src/vision/`** — AI vision element location using df-vision + Gemini (Stark) or appium-mcp server-side vision. Returns normalized coordinates.
- **`src/flow/`** — YAML flow execution. `parse-yaml-flow.ts` parses declarative steps; `run-yaml-flow.ts` executes them. Supports natural language steps, phased execution, variable interpolation from `.appclaw/env/`.
- **`src/device/`** — Device setup pipeline: platform selection → device picking → iOS-specific setup → Appium session creation.
- **`src/memory/`** — Episodic memory. Records successful trajectories to `~/.appclaw/trajectories.json`, retrieves relevant past experiences via fingerprinting.
- **`src/report/`** — Execution reporting. `writer.ts` collects artifacts; `renderer.ts` generates HTML reports; `server.ts` serves them.
- **`src/ui/terminal.ts`** — Rich terminal output (spinners, boxes, gradient headers, markdown rendering). JSON output mode for IDE integration (`json-emitter.ts`).

### Configuration (`src/config.ts`)

All config is via `.env` file, validated by Zod schema. Key vars: `LLM_PROVIDER`, `LLM_API_KEY`, `PLATFORM`, `AGENT_MODE` (dom vs vision), `MAX_STEPS`, `EXPORT_DIR` (default location for `--export` writes), `MCP_DEBUG` (verbose appium-mcp logs — function-evaluated so the SDK can flip it at runtime via the `mcpDebug` option). See README.md for the full table.

### Module Conventions

- ES2022 modules throughout (import/export)
- TypeScript strict mode
- Zod for schema validation
- No DI framework — modules import each other directly
- Constants and model pricing in `src/constants.ts`
