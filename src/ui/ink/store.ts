/**
 * UIStore — observable state the Ink agent-loop UI renders from.
 *
 * The agent loop (`loop.ts`) is imperative and long-lived: it *calls* UI
 * functions. Ink is declarative. This store is the seam between them — the
 * `InkRenderer` translates each `ui.*` call into a store mutation, and the
 * React tree subscribes via `useSyncExternalStore`.
 *
 * State is replaced immutably on every mutation so React re-renders cleanly.
 */

export type StepStatus = 'running' | 'done' | 'failed';

export interface StepData {
  step: number;
  maxSteps: number;
  /** short verb: tap / type / launch / done … */
  verb: string;
  /** action type → icon (click/type/scroll/…) */
  actionType: string;
  /** human target, e.g. "search icon" or "\"hello\" → field" */
  target: string;
  status: StepStatus;
  /** result detail line shown under the row */
  detail?: string;
  /** per-step token line */
  tokens?: { input: number; output: number; cached?: number; cost?: number };
  startedAt: number;
  durationMs?: number;
}

export type LogKind =
  | 'info'
  | 'warn'
  | 'error'
  | 'bullet'
  | 'recovery'
  | 'stuck'
  | 'reasoning'
  | 'preprocessor';

export interface LogEntry {
  kind: LogKind;
  text: string;
  detail?: string;
}

export interface TokenSummaryData {
  input: number;
  output: number;
  cached: number;
  cost: number;
  model: string;
}

export interface JourneySummaryData {
  success: boolean;
  overallGoal: string;
  subGoals: Array<{ goal: string; status: string; result?: string }>;
  totalSteps: number;
  durationMs: number;
  tokens: { input: number; output: number; cost: number; model: string };
}

/** A committed timeline entry — rendered once into Ink's <Static> (persists in scrollback). */
export type TimelineEntry =
  | { id: number; type: 'header'; goal: string; maxSteps: number }
  | { id: number; type: 'plan'; items: PlanItem[] }
  | { id: number; type: 'step'; data: StepData }
  | { id: number; type: 'log'; entry: LogEntry }
  | { id: number; type: 'subgoal'; index: number; total: number; goal: string }
  | { id: number; type: 'result'; result: ResultData; durationMs: number }
  | { id: number; type: 'summary'; data: TokenSummaryData }
  | { id: number; type: 'journey'; data: JourneySummaryData };

export interface PlanItem {
  goal: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  steps?: number;
  durationMs?: number;
}

/** Run-level context for the pinned bottom bar. */
export interface RunContext {
  overallGoal: string;
  subGoalIndex: number;
  subGoalTotal: number;
  currentSubGoal: string;
  model: string;
  mode: string;
}

export interface ResultData {
  status: 'success' | 'failed';
  reason: string;
  steps: number;
  tokens?: { input: number; output: number; cached: number; cost: number; model: string };
}

export interface UIState {
  goal?: string;
  maxSteps: number;
  /** Step number of the current/last action (for the bottom bar). */
  currentStep: number;
  /** Run context for the pinned bottom bar (agent mode). */
  ctx: RunContext;
  /** Live plan checklist — each sub-goal ticks green/red as it completes. */
  planGoals: PlanItem[];
  /** Start time of the current sub-goal (for per-item duration). */
  subGoalStart: number;
  /** Render committed per-step rows + result boxes. Off by default (debug-gated). */
  showSteps: boolean;
  /** Fullscreen mode: scrolling viewport + pinned footer (off in debug). */
  fullscreen: boolean;
  startTime: number;
  /** Committed, never-changing entries — go into <Static>. */
  timeline: TimelineEntry[];
  /** The step currently executing (shimmer row), not yet committed. */
  liveStep?: StepData;
  /** "Thinking" indicator shown while the LLM reasons (before a step exists). */
  thinking: { active: boolean; primary: string; detail?: string };
  /** Live streamed reasoning text (debug mode). */
  streaming: { active: boolean; label: string; text: string };
  /** Running token totals (footer). */
  tokens: { input: number; output: number; cached: number; cost: number };
  result?: ResultData;
  /** Active human-in-the-loop prompt (Ink owns stdin, so it can't use readline). */
  hitl?: {
    type: string;
    question: string;
    options?: string[];
    onSubmit: (answer: string) => void;
  };
}

function initial(): UIState {
  return {
    maxSteps: 0,
    currentStep: 0,
    ctx: {
      overallGoal: '',
      subGoalIndex: 0,
      subGoalTotal: 1,
      currentSubGoal: '',
      model: '',
      mode: '',
    },
    planGoals: [],
    subGoalStart: Date.now(),
    showSteps: true,
    fullscreen: false,
    startTime: Date.now(),
    timeline: [],
    thinking: { active: false, primary: '' },
    streaming: { active: false, label: 'Thinking', text: '' },
    tokens: { input: 0, output: 0, cached: 0, cost: 0 },
  };
}

let state: UIState = initial();
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function set(patch: Partial<UIState>): void {
  state = { ...state, ...patch };
  emit();
}

function commit(entry: TimelineEntry): void {
  set({ timeline: [...state.timeline, entry] });
}

// ── React external-store wiring ──
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getSnapshot(): UIState {
  return state;
}

// ── Mutators (called by InkRenderer) ──
export const store = {
  reset(): void {
    state = initial();
    seq = 0;
    emit();
  },

  setGoal(goal: string, maxSteps: number): void {
    set({
      goal,
      maxSteps,
      startTime: Date.now(),
      ctx: { ...state.ctx, overallGoal: goal, currentSubGoal: goal },
    });
    commit({ id: seq++, type: 'header', goal, maxSteps });
  },

  /** Seed the live plan checklist (all pending). */
  plan(subGoals: string[], _reasoning: string): void {
    set({ planGoals: subGoals.map((goal) => ({ goal, status: 'pending' as const })) });
  },

  /** Mark a plan item's status (index into planGoals). */
  markPlan(index: number, status: PlanItem['status'], steps?: number, durationMs?: number): void {
    if (index < 0 || index >= state.planGoals.length) return;
    const planGoals = state.planGoals.map((p, i) =>
      i === index
        ? {
            ...p,
            status,
            ...(steps != null ? { steps } : {}),
            ...(durationMs != null ? { durationMs } : {}),
          }
        : p
    );
    set({ planGoals });
  },

  /** Seed run-level context (overall goal, sub-goal total, model, mode). */
  setRunContext(ctx: Partial<RunContext>): void {
    set({ ctx: { ...state.ctx, ...ctx } });
  },

  setShowSteps(showSteps: boolean): void {
    set({ showSteps });
  },

  setFullscreen(fullscreen: boolean): void {
    set({ fullscreen });
  },

  /** Begin a sub-goal (agent mode): set budget + current step, no big box. */
  startSubGoal(goal: string, maxSteps: number): void {
    const idx = state.ctx.subGoalIndex;
    const planGoals = state.planGoals.map((p, i) =>
      i === idx && p.status === 'pending' ? { ...p, status: 'running' as const } : p
    );
    set({
      maxSteps,
      currentStep: 0,
      result: undefined, // previous sub-goal's result is committed; reopen the live bar
      subGoalStart: Date.now(),
      planGoals,
      ctx: {
        ...state.ctx,
        currentSubGoal: goal,
        // simple (single) goals carry the overall goal here too
        overallGoal: state.ctx.overallGoal || goal,
      },
    });
  },

  /** Orchestrator advanced to a sub-goal — update context + tick the checklist. */
  setSubGoal(index: number, total: number, overallGoal: string, goal: string): void {
    // Anything before `index` we've moved past — mark complete (handles skips).
    const planGoals = state.planGoals.map((p, i) => {
      if (i < index && p.status !== 'failed') return { ...p, status: 'done' as const };
      if (i === index && p.status === 'pending') return { ...p, status: 'running' as const };
      return p;
    });
    set({
      result: undefined,
      subGoalStart: Date.now(),
      planGoals,
      ctx: {
        ...state.ctx,
        overallGoal: overallGoal || state.ctx.overallGoal,
        subGoalIndex: index,
        subGoalTotal: total,
        currentSubGoal: goal,
      },
    });
    if (total > 1) commit({ id: seq++, type: 'subgoal', index, total, goal });
  },

  // thinking / streaming
  startThinking(primary: string, detail?: string): void {
    set({ thinking: { active: true, primary, detail } });
  },
  updateThinking(primary?: string, detail?: string): void {
    set({
      thinking: {
        active: true,
        primary: primary ?? state.thinking.primary,
        detail: detail ?? state.thinking.detail,
      },
    });
  },
  stopThinking(): void {
    set({ thinking: { active: false, primary: '' } });
  },
  startStreaming(label: string): void {
    set({ thinking: { active: false, primary: '' }, streaming: { active: true, label, text: '' } });
  },
  streamChunk(text: string): void {
    if (!state.streaming.active) return;
    set({ streaming: { ...state.streaming, text: state.streaming.text + text } });
  },
  stopStreaming(): void {
    set({ streaming: { active: false, label: 'Thinking', text: '' } });
  },

  // steps
  beginStep(
    step: number,
    maxSteps: number,
    verb: string,
    actionType: string,
    target: string
  ): void {
    // Any live thinking/streaming resolves into this step.
    set({
      maxSteps,
      currentStep: step,
      result: undefined,
      thinking: { active: false, primary: '' },
      streaming: { active: false, label: 'Thinking', text: '' },
      liveStep: {
        step,
        maxSteps,
        verb,
        actionType,
        target,
        status: 'running',
        startedAt: Date.now(),
      },
    });
  },
  setStepDetail(detail: string, status: StepStatus): void {
    if (!state.liveStep) return;
    set({ liveStep: { ...state.liveStep, detail, status } });
  },
  setStepTokens(input: number, output: number, cached?: number, cost?: number): void {
    if (!state.liveStep) return;
    set({ liveStep: { ...state.liveStep, tokens: { input, output, cached, cost } } });
  },
  /** Commit an already-resolved step in one shot (flow/replay — no running phase). */
  pushStep(
    step: number,
    maxSteps: number,
    verb: string,
    actionType: string,
    target: string,
    status: StepStatus,
    detail?: string
  ): void {
    if (state.liveStep) this.endStep();
    commit({
      id: seq++,
      type: 'step',
      data: { step, maxSteps, verb, actionType, target, status, detail, startedAt: Date.now() },
    });
  },

  /** Commit the running step into the timeline and clear the live row. */
  endStep(): void {
    if (!state.liveStep) return;
    const s = state.liveStep;
    const committed: StepData = {
      ...s,
      durationMs: Date.now() - s.startedAt,
      status: s.status === 'running' ? 'done' : s.status,
    };
    state = { ...state, liveStep: undefined };
    commit({ id: seq++, type: 'step', data: committed });
  },

  // tokens
  addTokens(input: number, output: number, cached: number, cost: number): void {
    set({
      tokens: {
        input: state.tokens.input + input,
        output: state.tokens.output + output,
        cached: state.tokens.cached + cached,
        cost: state.tokens.cost + cost,
      },
    });
  },

  // log lines
  log(kind: LogKind, text: string, detail?: string): void {
    commit({ id: seq++, type: 'log', entry: { kind, text, detail } });
  },

  // terminal (per sub-goal)
  finish(result: ResultData): void {
    // Make sure any half-open step is committed first.
    if (state.liveStep) {
      this.endStep();
    }
    const durationMs = Date.now() - state.startTime;
    // Tick the current plan item green/red.
    const idx = state.ctx.subGoalIndex;
    const planGoals = state.planGoals.map((p, i) =>
      i === idx
        ? {
            ...p,
            status: (result.status === 'success' ? 'done' : 'failed') as PlanItem['status'],
            steps: result.steps,
            durationMs: Date.now() - state.subGoalStart,
          }
        : p
    );
    set({
      thinking: { active: false, primary: '' },
      streaming: { active: false, label: 'Thinking', text: '' },
      result,
      planGoals,
    });
    commit({ id: seq++, type: 'result', result, durationMs });
  },

  /** Commit the final token/cost summary as its own timeline entry. */
  summary(data: TokenSummaryData): void {
    commit({ id: seq++, type: 'summary', data });
  },

  /** Commit the final journey summary panel (overall pass/fail + sub-goals). */
  journey(data: JourneySummaryData): void {
    if (state.liveStep) this.endStep();
    // Reconcile the checklist with the authoritative final statuses.
    const planGoals =
      data.subGoals.length === state.planGoals.length
        ? state.planGoals.map((p, i) => ({
            ...p,
            status: (data.subGoals[i].status === 'completed'
              ? 'done'
              : 'failed') as PlanItem['status'],
          }))
        : state.planGoals;
    set({
      thinking: { active: false, primary: '' },
      streaming: { active: false, label: 'Thinking', text: '' },
      result: { status: data.success ? 'success' : 'failed', reason: '', steps: data.totalSteps },
      planGoals,
    });
    // Commit a static checklist snapshot (persists in the scrollback dump),
    // then the summary panel.
    if (planGoals.length > 0) commit({ id: seq++, type: 'plan', items: planGoals });
    commit({ id: seq++, type: 'journey', data });
  },

  // human-in-the-loop
  askHitl(
    req: { type: string; question: string; options?: string[] },
    onSubmit: (answer: string) => void
  ): void {
    set({ hitl: { ...req, onSubmit } });
  },
  clearHitl(): void {
    set({ hitl: undefined });
  },
};

export type Store = typeof store;
