/**
 * Goal export — turn an agent run into a replayable SDK test.
 *
 * After `app.runGoal(goal)` finishes, the agent leaves behind a `history` of
 * tool-call decisions (find_and_click, find_and_type, launch_app, …). This
 * module translates those decisions back into the natural-language form that
 * `app.run(...)` accepts, then renders a complete vitest spec file.
 *
 * Why translate back to natural language instead of dumping raw tool calls?
 * The SDK's `app.run()` is the supported public surface — `find_and_click` is
 * an internal agent-loop concept. Natural-language steps are also human-readable
 * and survive minor UI changes better than coordinate-pinned tool calls.
 */

import type { AgentResult, StepRecord } from '../agent/loop.js';
import type { ToolCallDecision } from '../llm/provider.js';

/** Subset of AppClawOptions worth pinning into the generated test header. */
export interface GenerateSdkTestConfig {
  provider?: string;
  platform?: string;
  agentMode?: string;
  /** Module path used in the generated `import { AppClaw } from '<...>'`. Default: 'appclaw'. */
  sdkImport?: string;
  /** `describe(...)` block title. Default: 'Goal replay'. */
  describeName?: string;
  /** `it(...)` test title. Default: the goal text. */
  testName?: string;
  /** vitest timeout in ms. Default: 120000. */
  timeoutMs?: number;
}

/**
 * Translate one agent decision into a natural-language SDK instruction.
 * Returns null for decisions that have no replayable equivalent (`done`,
 * `screenshot`, internal book-keeping). Failed steps are filtered out by the
 * caller, not here.
 */
export function decisionToInstruction(decision: ToolCallDecision): string | null {
  const { toolName, args } = decision;
  switch (toolName) {
    case 'find_and_click': {
      const selector = (args.selector as string | undefined)?.trim();
      return selector ? `tap ${selector}` : null;
    }
    case 'find_and_long_press': {
      const selector = (args.selector as string | undefined)?.trim();
      return selector ? `long press ${selector}` : null;
    }
    case 'find_and_type': {
      const selector = (args.selector as string | undefined)?.trim();
      const text = (args.text as string | undefined) ?? '';
      if (!selector) return null;
      // Quote the text so multi-word strings parse correctly via tryParseNaturalFlowLine.
      return `type "${text.replace(/"/g, '\\"')}" into ${selector}`;
    }
    case 'launch_app': {
      // Prefer the friendly name (e.g. "YouTube") when the agent recorded one,
      // so the replay reads naturally. Fall back to the package/bundle ID.
      const appName = (args.appName as string | undefined)?.trim();
      const appId = (args.appId as string | undefined)?.trim();
      const target = appName || appId;
      return target ? `open ${target} app` : null;
    }
    case 'go_back':
      return 'back';
    case 'go_home':
      return 'home';
    case 'press_enter':
      return 'press enter';
    default:
      // done / screenshot / wait / get_info / anything custom — skip.
      // The agent's own retry/completion bookkeeping shouldn't show up in the replay.
      return null;
  }
}

/**
 * Drop steps from earlier "failed branches" within a single agent run.
 *
 * The agent's `done` tool is its "I'm finished" signal. The verification layer
 * may reject a `done` if the screen doesn't actually match the goal — in that
 * case the loop continues. Therefore: any `done` that is NOT the last record
 * in this history was rejected, and everything from the start of the history
 * up to and including that `done` was a failed branch that the agent then
 * recovered from.
 *
 * We keep only the records AFTER the last rejected `done` so the replay
 * captures just the successful path. If there are no rejected `done`s, the
 * input is returned unchanged.
 *
 * IMPORTANT: this must be applied per agent run (per sub-goal). A flat
 * concatenation of multiple sub-goals' histories would mis-identify each
 * sub-goal's accepted `done` as a "non-last rejected done".
 */
export function keepOnlyFinalAttempt(history: StepRecord[]): StepRecord[] {
  let lastRejectedIdx = -1;
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].decision.toolName === 'done') {
      lastRejectedIdx = i;
    }
  }
  if (lastRejectedIdx === -1) return history;
  return history.slice(lastRejectedIdx + 1);
}

/**
 * Build a descriptive `it(...)` test name from the recorded instructions.
 * Prefers anchors that tell a story: the launched app + the final user action,
 * e.g. "launches YouTube and taps search icon". Falls back to "executes <N>
 * recorded steps" when the trajectory doesn't have a clean anchor.
 */
function defaultTestNameFromSteps(instructions: string[]): string {
  if (instructions.length === 0) return 'executes 0 recorded steps';

  // The launched app is often the most identifying anchor for what the test covers.
  const opener = instructions.find((i) => /^open\s+.+\s+app$/i.test(i));
  // The last non-trivial step usually describes the user's intent at the end.
  const closer = [...instructions]
    .reverse()
    .find((i) => !/^(wait|back|home|press enter)\b/i.test(i));

  if (opener && closer && opener !== closer) {
    const appName = opener.replace(/^open\s+(.+)\s+app$/i, '$1');
    return `launches ${appName} and ${closer}`;
  }
  if (closer) return closer;
  return `executes ${instructions.length} recorded steps`;
}

/**
 * Build an array of natural-language instructions from an AgentResult's history.
 * Drops failed steps (they didn't actually affect the device state we want to
 * replay) and any decisions with no replayable equivalent.
 */
export function instructionsFromHistory(history: StepRecord[]): string[] {
  const out: string[] = [];
  for (const record of history) {
    // Skip steps whose `result` string clearly indicates failure. The agent's
    // recovery logic means a successful run may include failed attempts that
    // were superseded — replaying those would diverge from the live trajectory.
    const looksFailed = /^(failed|error|could not|element not found)/i.test(record.result);
    if (looksFailed) continue;
    const instruction = decisionToInstruction(record.decision);
    if (instruction) out.push(instruction);
  }
  return out;
}

/**
 * Render a complete vitest spec file that replays the agent's trajectory via
 * `app.run(...)` calls. The output is ready to write to disk and run with
 * `vitest run path/to/file`.
 */
export function generateSdkTest(opts: {
  goal: string;
  result: AgentResult;
  config?: GenerateSdkTestConfig;
}): string {
  return renderSdkTest({
    instructions: instructionsFromHistory(opts.result.history),
    goal: opts.goal,
    agentStepsUsed: opts.result.stepsUsed,
    config: opts.config,
  });
}

/**
 * Render a vitest spec from a flat list of natural-language instructions.
 *
 * Used by the playground (`/export some.test.ts`) where steps are already in
 * `app.run()`-ready form — no agent history to translate. The optional `goal`
 * is purely for the header comment; pass empty string if there's no concept
 * of a goal (interactive sessions).
 */
export function generateSdkTestFromInstructions(opts: {
  instructions: string[];
  goal?: string;
  config?: GenerateSdkTestConfig;
}): string {
  return renderSdkTest({
    instructions: opts.instructions,
    goal: opts.goal ?? '',
    config: opts.config,
  });
}

function renderSdkTest(opts: {
  instructions: string[];
  goal: string;
  agentStepsUsed?: number;
  config?: GenerateSdkTestConfig;
}): string {
  const cfg = opts.config ?? {};
  const { instructions, goal } = opts;
  const sdkImport = cfg.sdkImport ?? 'appclaw';
  const describeName = cfg.describeName ?? 'Recorded flow';
  // Default test name describes what the steps DO, not what the goal asked for.
  // The original goal is preserved in the file header comment for traceability.
  const testName = cfg.testName ?? defaultTestNameFromSteps(instructions);
  const timeoutMs = cfg.timeoutMs ?? 120000;
  const agentStepsUsed = opts.agentStepsUsed;

  const optionLines: string[] = [];
  if (cfg.provider) optionLines.push(`      provider: ${JSON.stringify(cfg.provider)},`);
  optionLines.push(`      apiKey: process.env.LLM_API_KEY,`);
  if (cfg.platform) optionLines.push(`      platform: ${JSON.stringify(cfg.platform)},`);
  if (cfg.agentMode) optionLines.push(`      agentMode: ${JSON.stringify(cfg.agentMode)},`);

  const runLines = instructions.map((i) => `    await app.run(${JSON.stringify(i)});`);

  const fromAgent = agentStepsUsed !== undefined;
  const goalLine = goal.trim()
    ? `Original goal: ${goal.replace(/\*\//g, '*\\/')}`
    : 'Source: AppClaw playground';
  const stepsLine = fromAgent
    ? `Steps recorded: ${instructions.length} (from ${agentStepsUsed} agent step${agentStepsUsed === 1 ? '' : 's'})`
    : `Steps recorded: ${instructions.length}`;

  // Caveats vary by source: agent-mode exports inherit non-determinism from the
  // LLM trajectory; playground exports are user-validated steps and only need a
  // brief reminder that selectors may drift across UI revisions.
  const caveats = fromAgent
    ? [
        '1. Replay does not have the goal-mode safety net. In goal mode the agent',
        '   re-checks the screen after each step, retries failed actions, and adapts',
        '   when the UI is in an unexpected state. `app.run(...)` calls below do none',
        '   of that — each step fires once and moves on. If a step worked on the',
        "   second try in goal mode, it may need an explicit `app.run('wait 2 seconds')`",
        '   or an `app.verify(...)` checkpoint here before the next step.',
        '',
        '2. Failed/recovered steps were filtered out, so the count above may differ',
        '   from what you saw in the live run.',
        '',
        '3. Coverage is best-effort. The translator (sdk/goal-export.ts) maps a fixed',
        "   set of agent tools to natural language. Any newer agent tool that isn't",
        '   in that map is silently skipped — if your replay is missing a step,',
        '   cross-check against the AgentResult.history.',
        '',
        '4. Edit freely. Treat this file as a draft: rename the test, add assertions',
        '   (`app.verify(...)`), tighten selectors, split into multiple `it()` blocks.',
      ]
    : [
        '1. Each step is the verbatim text you typed in the playground — exactly',
        '   what `AppClaw.run()` will receive. There is no translator in between,',
        '   so the replay should behave identically to the playground session.',
        '',
        '2. Selectors are still locator strings, not stable IDs. If the app UI',
        '   changes (icons relabelled, layout shifts), the natural-language',
        '   selectors above may need updating.',
        '',
        '3. Edit freely. Treat this file as a draft: rename the test, add',
        '   assertions (`app.verify(...)`), split into multiple `it()` blocks.',
      ];

  const caveatBlock = caveats.map((l) => ` * ${l}`.replace(/ +$/, '')).join('\n');

  return `/**
 * Generated by AppClaw — a replayable starting point, not a final test.
 *
 * ${goalLine}
 * ${stepsLine}
 *
 * Caveats — read before running this in CI:
 *
${caveatBlock}
 */
import { AppClaw } from ${JSON.stringify(sdkImport)};
import { describe, it } from 'vitest';
import 'dotenv/config';

describe(${JSON.stringify(describeName)}, () => {
  it(${JSON.stringify(testName)}, async () => {
    const app = new AppClaw({
${optionLines.join('\n')}
    });

${runLines.join('\n')}

    await app.teardown();
  }, ${timeoutMs});
});
`;
}
