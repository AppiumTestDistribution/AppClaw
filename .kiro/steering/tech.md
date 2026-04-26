# Tech Stack

## Language & Runtime

- **TypeScript** (strict mode, ES2022 modules)
- **Node.js** 18+ runtime
- **tsx** for dev/local execution without compiling

## Build System

- **TypeScript compiler** (`tsc`) — outputs to `dist/`, mirrors `src/` structure
- **No bundler** for the main package — pure tsc compilation
- **Vite** available in node_modules (used by VS Code extension)

## Key Libraries

- **Vercel AI SDK** (`ai`, `@ai-sdk/*`) — multi-provider LLM abstraction
- **appium-mcp** — Appium Model Context Protocol server (stdio or SSE transport)
- **@modelcontextprotocol/sdk** — MCP client
- **Zod** — schema validation (config, LLM responses, flow schemas)
- **yaml** — YAML flow file parsing
- **sharp** — image processing for screenshots
- **df-vision** — Stark vision element location (Gemini-backed)
- **dotenv** — `.env` config loading
- **express** — report server
- **hono** — MCP server HTTP layer
- **vitest** — test runner
- **prettier** — code formatting

## LLM Providers

Supported via Vercel AI SDK: `anthropic`, `openai`, `gemini`, `groq`, `ollama`

## Code Style

- Prettier config: single quotes, semi, 100 char print width, 2-space indent, trailing commas (ES5)
- No DI framework — modules import each other directly
- Zod for all external data validation
- Constants and model pricing centralized in `src/constants.ts`

## Common Commands

```bash
# Development
npm start                    # run via tsx (no compile)
npm start "goal"             # run with a goal
npm run dev                  # run with file watching

# Build & Type Check
npm run build                # tsc → dist/
npm run typecheck            # type-check only, no emit
npm run lint                 # alias for typecheck

# Formatting
npm run format               # prettier --write
npm run format:check         # prettier --check

# Tests
npm test                     # vitest run tests/flow tests/sdk
npm run test:e2e             # vitest run tests/e2e/
npm run test:e2e:android     # android e2e with MCP_DEBUG=1
npm run test:watch           # vitest watch mode

# VS Code Extension
npm run build:vsix           # build .vsix package

# Landing page
npm run deploy:landing       # deploy to Cloudflare Workers
```

## Configuration

All runtime config via `.env`, validated by Zod schema in `src/config.ts`. Key variables:

| Variable         | Default  | Description                                       |
| ---------------- | -------- | ------------------------------------------------- |
| `LLM_PROVIDER`   | `gemini` | `anthropic`, `openai`, `gemini`, `groq`, `ollama` |
| `LLM_API_KEY`    | —        | API key for chosen provider                       |
| `AGENT_MODE`     | `dom`    | `dom` or `vision`                                 |
| `PLATFORM`       | (prompt) | `android` or `ios`                                |
| `MAX_STEPS`      | `30`     | Max steps per goal                                |
| `CLOUD_PROVIDER` | —        | `lambdatest` for remote devices                   |

## Release

Automated via **semantic-release** with conventional commits. Config in `.releaserc.json`.
