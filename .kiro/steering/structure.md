# Project Structure

## Root Layout

```
appclaw/
├── src/              # All TypeScript source (compiled → dist/)
├── dist/             # Compiled output (mirrors src/, gitignored)
├── tests/            # Test files (vitest)
├── flows/            # Example YAML flow files
├── examples/         # Example flows and PRDs
├── schemas/          # JSON schemas (flow.schema.json, env.schema.json)
├── skills/           # AI agent skill definitions (generate-appclaw-flow, use-appclaw-cli)
├── bin/              # CLI entry point (bin/appclaw.js)
├── docs/             # QA documentation
├── logs/             # Runtime execution logs (gitignored)
├── vscode-extension/ # VS Code extension (separate package.json + tsconfig)
├── github-action/    # GitHub Action definition
├── landing/          # Cloudflare Workers landing page
└── .appclaw/         # Runtime data: guides/, runs/ (recordings, screenshots)
```

## Source Modules (`src/`)

| Module           | Responsibility                                                                    |
| ---------------- | --------------------------------------------------------------------------------- |
| `index.ts`       | CLI entry — routes to all 6 modes based on flags                                  |
| `config.ts`      | Zod-validated config from `.env`                                                  |
| `constants.ts`   | Default models, pricing, stuck detection thresholds                               |
| `agent/`         | Core agent loop, stuck detection, recovery, planner, human-in-the-loop            |
| `llm/`           | Multi-provider LLM integration — provider factory, prompt builder, action schemas |
| `mcp/`           | Appium MCP client — tool calling, element finding, screenshots, keyboard          |
| `perception/`    | Screen parsing — Android/iOS XML parsers, DOM trimmer, screen diff                |
| `vision/`        | AI vision element location via Stark (df-vision + Gemini)                         |
| `flow/`          | YAML flow parsing and execution, natural language step handling, parallel runner  |
| `device/`        | Device setup pipeline — platform/device picker, iOS setup, Appium session         |
| `memory/`        | Episodic memory — trajectory recording, fingerprinting, retrieval                 |
| `explorer/`      | PRD → YAML flow generation, screen crawler                                        |
| `playground/`    | Interactive REPL for building flows                                               |
| `recording/`     | Session recorder and adaptive replayer                                            |
| `report/`        | Run artifact collection, HTML report rendering, Express server                    |
| `sdk/`           | Public SDK — `GoalRunner`, `FlowRunner`, `StepRunner`, config builder             |
| `skills/`        | Built-in skill implementations (find-and-tap, read-screen, submit-message)        |
| `ui/terminal.ts` | Rich terminal output — spinners, boxes, markdown rendering                        |
| `appguides/`     | App-specific interaction guides                                                   |

## Tests (`tests/`)

```
tests/
├── flow/       # Flow parsing and execution unit tests
├── sdk/        # SDK integration tests
├── e2e/        # End-to-end device tests (require connected device)
├── vision/     # Vision module tests
└── flows/      # YAML flow fixtures used by tests
```

## Key Conventions

- Each `src/` subdirectory typically has an `index.ts` as its public interface
- Types are co-located in `types.ts` within each module
- No barrel re-exports at the root `src/` level — import from specific modules
- The SDK (`src/sdk/`) is the only public API surface; everything else is internal
- YAML flows live in `flows/` (project-level) or `examples/flows/` (examples)
- `.appclaw/runs/` stores per-run artifacts: `manifest.json`, `recording.mp4`, step screenshots
- `.appclaw/guides/` stores per-app interaction guides keyed by bundle/package ID
