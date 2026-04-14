# QA: Trajectory as Regression Baseline

## Problem

AppClaw's trajectory store already records the exact path a successful run took — the sequence of actions, selectors, and step counts. This is a regression baseline sitting unused. There is no way today to compare a current run against a previous one and flag changes.

## Insight

A regression is detectable when:

- The same goal on the same app **took more steps** than before
- A screen that used to appear **no longer appears**
- An action that always worked **now fails**
- The completion path **diverged** from the recorded trajectory

## Proposed Design

### Regression report per run

After each run, compare against the stored trajectory for the same (goal, app, platform) and emit a diff:

```
Regression Check: "complete checkout"  app: com.starbucks
─────────────────────────────────────────────────────────
✓  Step 1: find_and_click "Add to Cart"         (same)
✓  Step 2: find_and_click "Proceed to Checkout" (same)
⚠  Step 3: NEW — dismiss_popup "Enable notifications"  (not in baseline)
✓  Step 4: find_and_click "Apple Pay"           (same)
✗  Step 5: MISSING — order confirmation screen  (appeared in baseline, not now)

Steps: 4 (baseline: 4) ✓  |  New steps: 1  |  Missing steps: 1
```

### CLI flag

```bash
appclaw --flow checkout.yaml --check-regression
appclaw --flow checkout.yaml --update-baseline   # overwrite stored baseline
```

### Baseline storage

Extend `TrajectoryEntry` in `src/memory/types.ts` with an ordered step sequence (not just the winning final action) so full path comparison is possible.

Or store baselines separately at `~/.appclaw/baselines/<appId>/<goalHash>.json`.

## Step Count Heuristic (Quick Win)

Without full path comparison, step count delta alone is a useful signal:

```
⚠ Regression risk: "complete checkout" took 7 steps (baseline: 4). App may have added screens.
```

This requires no schema changes — `stepsInRun` is already stored in `TrajectoryEntry`.

Surface this warning in the run summary today.

## Files to Touch

- `src/memory/types.ts` — extend `TrajectoryEntry` with step sequence (optional, for full diff)
- `src/memory/retriever.ts` — add baseline comparison function
- `src/agent/loop.ts` — emit regression warning at run end
- `src/report/writer.ts` — include regression diff in HTML report
- `src/config.ts` — add `--check-regression` and `--update-baseline` flags
