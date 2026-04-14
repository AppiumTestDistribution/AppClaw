# QA: Observed Behavior Assertions

## Problem

AppClaw completes a task and declares success, but gives no structured record of _what it observed_ — prices, confirmation messages, order numbers, screen states. On the next run there is no way to know if the outcome was the same.

## Concept

After a successful run, an LLM call reads the agent's step history and extracts observable facts as assertions:

```
Run: "complete checkout for 1 large oat milk latte"
Observed assertions:
  ✓ Order confirmation screen appeared
  ✓ Item: "Oat Milk Latte, Large" shown
  ✓ Price shown: $6.95
  ✓ Payment method: Apple Pay
  ✓ Estimated ready time shown
  ✓ Completed in 4 steps
```

On subsequent runs these become **soft assertions** — the agent flags any that no longer hold.

## Assertion Types

| Type            | Example                              | How detected                       |
| --------------- | ------------------------------------ | ---------------------------------- |
| Screen appeared | "Order confirmation screen appeared" | Screen fingerprint match           |
| Text present    | "Price shown: $6.95"                 | LLM extraction from DOM/screenshot |
| Step count      | "Completed in 4 steps"               | `stepsInRun` from trajectory       |
| Element state   | "Apple Pay button was selected"      | LLM extraction                     |

## Proposed Design

### Extraction (async, post-run)

```typescript
// After successful finalize()
const assertions = await extractAssertions(stepHistory, goal, llmClient);
saveAssertions(appId, goalHash, assertions);
```

Prompt to LLM:

```
Given this agent run transcript, extract 3-6 observable facts about the outcome
as short assertion strings. Focus on: screens that appeared, values shown,
actions completed. Be specific. Format: one assertion per line.
```

### Storage

`~/.appclaw/assertions/<appId>/<goalHash>.json`

```json
{
  "goal": "complete checkout",
  "appId": "com.starbucks",
  "extractedAt": 1712345678,
  "assertions": ["Order confirmation screen appeared", "Price shown: $6.95", "Completed in 4 steps"]
}
```

### Soft assertion check on next run

At run end, retrieve stored assertions and ask the LLM:

```
Previous run observed: ["Order confirmation screen appeared", "Price shown: $6.95"]
Based on the current run transcript, which of these still hold? Which do not?
```

Emit result in terminal and HTML report.

### Hard assertions in YAML flows

QA engineers can also write explicit assertions in flow files:

```yaml
steps:
  - tap checkout
  - ...
assertions:
  - order confirmation screen is visible
  - price displayed is under $10
  - no error messages present
```

These run after all steps complete and fail the flow if any assertion fails.

## Files to Touch

- New: `src/assertions/extractor.ts` — LLM-based assertion extraction
- New: `src/assertions/checker.ts` — compare assertions against current run
- New: `src/assertions/store.ts` — persist/load assertion sets
- `src/flow/parse-yaml-flow.ts` — parse `assertions:` block from YAML
- `src/flow/run-yaml-flow.ts` — run assertion checker after steps complete
- `src/agent/loop.ts` — trigger async extraction on success
- `src/report/writer.ts` — include assertion results in HTML report
