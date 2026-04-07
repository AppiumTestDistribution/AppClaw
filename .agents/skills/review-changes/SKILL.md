---
name: review-changes
description: >
  Review code changes in the AppClaw repo for correctness, CLI/VSCode extension consistency,
  and YAML flow parsing regressions. Use this skill whenever the user says "review my changes",
  "check my changes", "validate changes", "does this break anything", "review the diff",
  or any variation of wanting to verify that recent code modifications haven't broken
  the CLI, VSCode extension, or YAML flow parsing. Also use when the user is about to
  commit or push and wants a sanity check.
---

# Review Changes

This skill reviews code changes in AppClaw to catch breakage across two surfaces (CLI and VSCode extension) and validate YAML flow parsing. AppClaw has a fragile contract between these surfaces — the CLI emits NDJSON events that the extension parses, and changes to either side can silently break the other.

## Why this matters

AppClaw has three main failure modes when code changes:

1. **CLI ↔ Extension drift** — The CLI's `src/json-emitter.ts` defines event types. The extension's `vscode-extension/src/bridge.ts` mirrors those types manually. When someone adds a field to one side, the other silently ignores it, causing subtle bugs.
2. **YAML flow parsing regressions** — Natural language parsing in `src/flow/natural-line.ts` uses regex patterns that interact in surprising ways. A change to one regex can break another flow format.
3. **Config drift** — The CLI reads env vars via `src/config.ts` (Zod schema). The extension maps VS Code settings to env vars in `bridge.ts:getEnvFromSettings()`. New config options added to one side may not appear in the other.

## Review process

When triggered, perform these checks in order:

### Step 1: Identify what changed

Run `git diff` (staged + unstaged) and `git diff --cached` to see all pending changes. Categorize the changed files:

- **Shared contract files** (high risk): `src/json-emitter.ts`, `src/flow/types.ts`, `src/config.ts`
- **CLI-side flow files** (medium risk): `src/flow/natural-line.ts`, `src/flow/parse-yaml-flow.ts`, `src/flow/run-yaml-flow.ts`, `src/flow/variable-resolver.ts`, `src/flow/llm-parser.ts`
- **Extension files** (medium risk): anything under `vscode-extension/src/`
- **Other files** (lower risk): agent, perception, vision, etc.

### Step 2: Cross-surface consistency check

If any shared contract files changed, or if extension/CLI files changed:

**Event type check:**

- Read `src/json-emitter.ts` (the `JsonEvent` type union)
- Read `vscode-extension/src/bridge.ts` (the `AppclawEvent` type and individual event interfaces)
- Compare every event variant — field names, types, optional vs required
- Flag any mismatch (missing fields, type differences, new events not mirrored)

**Config mapping check:**

- Read `src/config.ts` (the Zod schema for env vars)
- Read the `getEnvFromSettings()` function in `vscode-extension/src/bridge.ts`
- Read `vscode-extension/package.json` contributes.configuration section
- Verify every env var the CLI reads has a corresponding VS Code setting + mapping

**Report format:**

```
## Cross-Surface Consistency

### Event Types
- [OK] connected — fields match
- [DRIFT] flow_done — CLI has `failedPhase?: string` and `phaseResults?: unknown[]`, extension bridge is missing both
- [NEW] screen — not handled in extension's formatEvent (returns null)

### Config Mapping
- [OK] LLM_PROVIDER — mapped via llmProvider setting
- [MISSING] NEW_CONFIG_VAR — added to CLI config but no VS Code setting exists
```

### Step 3: YAML flow parsing validation

Run the test suites to verify parsing still works:

```bash
# Run vitest for flow parsing, variable resolution, and cross-surface validation
cd /Users/saikrishna/Documents/git/appclaw && npm test

# Run the integration verification script
npx tsx tests/verify-parsing.ts
```

If tests fail, report which tests failed and why. If tests pass, confirm that.

Then, if `natural-line.ts` or `parse-yaml-flow.ts` changed, do an additional manual audit:

- Read the changed regex patterns
- Check each example YAML flow file against the parser mentally:
  - `examples/flows/google-search.yaml` (legacy structured: `tap:`, `type:`, `done:`)
  - `examples/flows/vodqa-natural.yaml` (natural language flat)
  - `examples/flows/settings-wifi-on.yaml` (structured with comments)
  - `examples/flows/youtube-search-appium3.yaml` (mixed natural + structured)
  - `tests/flows/youtube-phased.yaml` (phased with variables)
  - `flows/youtube.yaml` (legacy flat with phases)
- Flag any step that would now parse differently or fail

### Step 4: TypeScript compilation check

```bash
cd /Users/saikrishna/Documents/git/appclaw && npm run typecheck
```

Report any type errors, especially ones related to the changed files.

### Step 5: Summary report

Present findings as a structured report:

```
# Change Review Summary

## Files Changed
- list of files with risk level

## Cross-Surface Issues
- any drift or mismatches found (or "None found")

## YAML Parsing
- test results (pass/fail counts)
- any regressions identified

## Type Check
- clean or errors found

## Recommendations
- specific fixes needed, if any
```

Be direct — if everything looks good, say so briefly. If there are issues, be specific about what's wrong and suggest the fix.

## Important edge cases

- If the user only changed files that don't affect the CLI/extension contract (e.g., only `src/agent/` files), skip the cross-surface check and say so.
- Tests use vitest (`npm test`). The cross-surface contract test (`tests/flow/cross-surface.test.ts`) automatically validates CLI ↔ extension event parity.
- The extension has its own build step (`cd vscode-extension && npm run compile`). If extension files changed, run that too.
