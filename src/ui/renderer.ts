/**
 * Renderer seam — lets an alternate UI (Ink) take over terminal output.
 *
 * `terminal.ts` exposes ~40 imperative print functions called from ~20 files.
 * Rather than rewrite every call site, those functions dispatch through this
 * registry: when an Ink renderer is registered (interactive TTY), the matching
 * method runs; otherwise the original plain-console implementation runs.
 *
 * The interface covers the *agent-loop* surface — the high-churn output that
 * the Ink TUI owns (header, steps, spinner, streaming, tokens, result, and the
 * inline log lines emitted during a run). Everything else stays plain.
 *
 * All methods are optional at registration time (`Partial<UIRenderer>`), so a
 * renderer can implement a subset and let the rest fall through to plain.
 */

export interface JourneySummaryInput {
  success: boolean;
  overallGoal: string;
  subGoals: Array<{ goal: string; status: string; result?: string }>;
  totalSteps: number;
  durationMs: number;
  tokens: { input: number; output: number; cost: number; model: string };
}

export interface UIRenderer {
  // ── Goal / header ──
  printGoalStart(goal: string, maxSteps: number): void;
  printPlan(subGoals: Array<{ goal: string }>, reasoning: string): void;

  // ── Steps ──
  printStep(step: number, maxSteps: number, toolName: string, argsSummary: string): void;
  printStepDetail(message: string): void;
  printStepError(message: string): void;
  printStepTokens(
    inputTokens: number,
    outputTokens: number,
    cachedTokens?: number,
    cost?: number,
    label?: string
  ): void;

  // ── Terminal states ──
  printGoalSuccess(steps: number, reason: string): void;
  printGoalFailed(reason: string): void;
  printTokenSummary(
    totalInput: number,
    totalOutput: number,
    cost: number,
    modelName: string,
    totalCached?: number
  ): void;

  // ── Spinner / streaming (stateful) ──
  startSpinner(message: string, detail?: string, rotateWords?: boolean): void;
  updateSpinner(message?: string, detail?: string): void;
  stopSpinner(finalMessage?: string): void;
  startStreaming(label?: string): void;
  streamChunk(text: string): void;
  stopStreaming(): void;
  printReasoning(text: string): void;

  // ── Inline log lines ──
  printAgentBullet(message: string): void;
  printInfo(message: string): void;
  printWarning(message: string): void;
  printError(message: string, detail?: string): void;
  printStuck(step: number): void;
  printRecovery(message: string): void;
  printPreprocessor(message: string): void;
  printScreenReadiness(issues: string[], suggestedAction?: string): void;

  // ── Journey summary (final pass/fail panel) ──
  printJourneySummary(data: JourneySummaryInput): void;

  // ── Orchestration (multi sub-goal) ──
  printPlanContext(
    overallGoal: string,
    currentGoal: string,
    allGoals: Array<{ goal: string; status: string }>,
    currentIndex: number
  ): void;
  printOrchestratorProceed(subGoal: string): void;
  printOrchestratorSkip(subGoal: string, reason: string): void;
  printOrchestratorRewrite(original: string, rewritten: string): void;

  // ── Flow / replay / explorer surfaces ──
  printReplayGoal(goal: string, totalSteps: number): void;
  printReplayStep(
    step: number,
    total: number,
    toolName: string,
    adapted: boolean,
    success: boolean
  ): void;
  printReplayResult(passed: number, total: number, adapted: number): void;
  printFlowStep(step: number, total: number, label: string, success: boolean): void;
  printExplorerPhase(phase: string, message: string): void;
}

let active: Partial<UIRenderer> | null = null;

/** Register the active renderer (Ink). Pass null to restore plain output. */
export function setRenderer(renderer: Partial<UIRenderer> | null): void {
  active = renderer;
}

/** The active renderer, or null when plain console output should be used. */
export function getRenderer(): Partial<UIRenderer> | null {
  return active;
}

/** True when an Ink renderer currently owns the screen. */
export function isInkActive(): boolean {
  return active !== null;
}
