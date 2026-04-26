# AppClaw — Product Overview

AppClaw is an agentic AI layer for mobile automation on Android and iOS. Users describe goals in plain English and AppClaw orchestrates device interactions through Appium (via MCP). It supports multiple LLM providers (Anthropic, OpenAI, Google Gemini, Groq, Ollama) via the Vercel AI SDK.

## Core Modes

- **Agent mode** — LLM-driven goal execution (e.g. `appclaw "Send a WhatsApp message to Mom"`)
- **YAML flows** — declarative, zero-LLM automation steps defined in YAML files
- **Playground** — interactive REPL for building flows live on a device
- **Explorer** — generates YAML test flows from a PRD or app description
- **Record/Replay** — capture and adaptively replay goal executions
- **Report** — Express server serving HTML run reports

## Two Agent Modes

- `dom` — uses XML page source and accessibility IDs/XPath to locate elements
- `vision` — screenshot-first using Stark (df-vision + Gemini) for element location

## Perception → Reason → Act Loop

Each step: read screen state → send to LLM → execute action (tap/type/swipe/etc.) → repeat until goal complete or max steps reached.

## Published Artifacts

- **npm package** (`appclaw`) — CLI + SDK
- **VS Code extension** — live multi-device grid view
- **GitHub Action** — CI integration
- **Landing page** — Cloudflare Workers static site
