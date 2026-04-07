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

### Core Agent Loop (`src/agent/loop.ts`)

The main Perception→Reasoning→Action loop:

1. **Perceive** — get screen state (DOM XML or screenshot) via `src/perception/`
2. **Reason** — send trimmed DOM + goal + history to LLM via `src/llm/`
3. **Act** — execute action (tap, type, swipe) via appium-mcp through `src/mcp/`
4. **Feedback** — check for stuck state (`src/agent/stuck.ts`), adapt if needed
5. **Loop** until goal complete or max steps reached

Supporting agent modules: planner (goal decomposition), recovery (checkpointing), human-in-the-loop (OTP/CAPTCHA pauses), episodic memory (trajectory reuse).

### Key Module Responsibilities

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

All config is via `.env` file, validated by Zod schema. Key vars: `LLM_PROVIDER`, `LLM_API_KEY`, `PLATFORM`, `AGENT_MODE` (dom vs vision), `MAX_STEPS`. See README.md for the full table.

### Module Conventions

- ES2022 modules throughout (import/export)
- TypeScript strict mode
- Zod for schema validation
- No DI framework — modules import each other directly
- Constants and model pricing in `src/constants.ts`
