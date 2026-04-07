/**
 * Goal decomposition planner — breaks complex goals into sub-goals.
 *
 * Uses the LLM to analyze a complex goal and produce a sequence of
 * simpler sub-goals that can each be executed by the agent loop.
 *
 * Example:
 *   "Send a WhatsApp to Mom saying good morning, then check my emails"
 *   → ["Open WhatsApp", "Find Mom in contacts", "Type 'good morning'",
 *      "Send the message", "Open email app", "Check inbox"]
 */

import { generateObject } from 'ai';
import { z } from 'zod';

const planSchema = z.object({
  isComplex: z.boolean().describe('Whether the goal needs decomposition'),
  subGoals: z
    .array(
      z.object({
        goal: z.string().describe('A single, atomic sub-goal'),
        app: z.string().optional().describe('Target app if known (package name or bundle ID)'),
        dependsOn: z.number().optional().describe('Index of sub-goal this depends on (0-based)'),
      })
    )
    .describe('Ordered list of sub-goals'),
  reasoning: z.string().describe('Why this decomposition was chosen'),
});

export type GoalPlan = z.infer<typeof planSchema>;

export interface SubGoal {
  index: number;
  goal: string;
  app?: string;
  dependsOn?: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
}

export interface PlannerResult {
  isComplex: boolean;
  subGoals: SubGoal[];
  reasoning: string;
}

/**
 * Decompose a goal into sub-goals using the LLM.
 * Simple goals pass through unchanged.
 */
export async function decomposeGoal(
  goal: string,
  model: any,
  providerOptions?: Record<string, any>
): Promise<PlannerResult> {
  const { object } = await generateObject({
    model,
    schema: planSchema,
    system: PLANNER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: goal }],
    ...(providerOptions ? { providerOptions } : {}),
  });

  if (!object.isComplex || object.subGoals.length <= 1) {
    return {
      isComplex: false,
      subGoals: [{ index: 0, goal, status: 'pending' }],
      reasoning: 'Simple goal — no decomposition needed',
    };
  }

  return {
    isComplex: true,
    subGoals: object.subGoals.map((sg, i) => ({
      index: i,
      goal: sg.goal,
      app: sg.app,
      dependsOn: sg.dependsOn,
      status: 'pending' as const,
    })),
    reasoning: object.reasoning,
  };
}

/**
 * Run the agent on each sub-goal in sequence.
 * Returns results for each sub-goal.
 */
export function createPlanExecutor(subGoals: SubGoal[]) {
  let currentIndex = 0;

  return {
    get current(): SubGoal | null {
      return subGoals[currentIndex] ?? null;
    },

    get all(): SubGoal[] {
      return subGoals;
    },

    get progress(): string {
      const done = subGoals.filter((sg) => sg.status === 'completed').length;
      return `[${done}/${subGoals.length}]`;
    },

    markCompleted(result: string) {
      if (subGoals[currentIndex]) {
        subGoals[currentIndex].status = 'completed';
        subGoals[currentIndex].result = result;
        currentIndex++;
      }
    },

    markFailed(result: string) {
      if (subGoals[currentIndex]) {
        subGoals[currentIndex].status = 'failed';
        subGoals[currentIndex].result = result;
        currentIndex++;
      }
    },

    isDone(): boolean {
      return currentIndex >= subGoals.length;
    },

    /** Get a summary of plan progress for the LLM context */
    getSummary(): string {
      return subGoals
        .map((sg, i) => {
          const status =
            sg.status === 'completed'
              ? '✅'
              : sg.status === 'failed'
                ? '❌'
                : sg.status === 'in_progress'
                  ? '▶️'
                  : '⬜';
          return `${status} ${i + 1}. ${sg.goal}${sg.result ? ` (${sg.result})` : ''}`;
        })
        .join('\n');
    },
  };
}

// ─── Mid-execution screen evaluator ────────────────────

const screenEvalSchema = z.object({
  status: z
    .enum(['done', 'adapt', 'continue'])
    .describe(
      'done = the goal is already achieved on the current screen, ' +
        'adapt = the goal needs rewording because an overlay/popup/unexpected state appeared, ' +
        'continue = keep executing the current goal as-is'
    ),
  reason: z.string().describe('Brief explanation'),
  adaptedGoal: z.string().optional().describe('Reworded goal if status=adapt'),
});

const SCREEN_EVAL_PROMPT = `You are a mobile automation screen evaluator. You are given a sub-goal and the current screen DOM.

Your ONLY job: detect if an OVERLAY is blocking the current goal and needs to be handled first.

Overlays include:
- Autocomplete/suggestion dropdowns that appeared after typing
- Permission dialogs
- Error dialogs or alerts
- Popup menus or bottom sheets that cover other elements

Return "adapt" ONLY if you see an overlay in the DOM that is blocking the goal. The adapted goal should describe how to dismiss the specific overlay (tap a specific element from the DOM).

Return "done" if the current sub-goal is clearly already achieved on the current screen.

Return "continue" for everything else — this is the DEFAULT. When in doubt, return "continue".

STRICT RULES:
- NEVER suggest navigation (go back, launch app, tap compose, open screen)
- NEVER suggest re-entering data or redoing completed work
- NEVER suggest multi-step workflows — only a single overlay dismissal action
- The adapted goal must reference a SPECIFIC element visible in the current DOM
- If the screen looks different than expected but there is no overlay blocking, return "continue" and let the agent figure it out`;

/**
 * Evaluate the current screen mid-execution to detect unexpected states.
 * Returns null if no evaluation is needed (continue as-is).
 */
export async function evaluateScreen(
  model: any,
  currentGoal: string,
  currentDom: string,
  providerOptions?: Record<string, any>
): Promise<{ adapt: boolean; adaptedGoal?: string; done?: boolean; reason: string } | null> {
  try {
    const { object } = await generateObject({
      model,
      schema: screenEvalSchema,
      system: SCREEN_EVAL_PROMPT,
      messages: [
        {
          role: 'user',
          content: `CURRENT GOAL: ${currentGoal}\n\nCURRENT SCREEN (DOM):\n${currentDom}`,
        },
      ],
      ...(providerOptions ? { providerOptions } : {}),
    });

    if (object.status === 'continue') return null;
    if (object.status === 'done') return { adapt: false, done: true, reason: object.reason };
    if (object.status === 'adapt' && object.adaptedGoal) {
      return { adapt: true, adaptedGoal: object.adaptedGoal, reason: object.reason };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Screen-aware orchestrator ─────────────────────────

const orchestratorSchema = z.object({
  action: z
    .enum(['skip', 'rewrite', 'proceed'])
    .describe(
      'skip = sub-goal is already achieved on current screen, ' +
        'rewrite = sub-goal needs rewording based on current screen state, ' +
        'proceed = execute sub-goal as-is'
    ),
  reason: z.string().describe('Brief explanation of the decision'),
  rewrittenGoal: z.string().optional().describe('The reworded sub-goal (only if action=rewrite)'),
});

export type OrchestratorDecision = z.infer<typeof orchestratorSchema>;

/**
 * Evaluate a sub-goal against the current screen state.
 * Returns whether to skip, rewrite, or proceed with the sub-goal.
 */
export async function evaluateSubGoal(
  model: any,
  overallGoal: string,
  subGoal: string,
  completedGoals: string[],
  currentScreenDOM: string,
  providerOptions?: Record<string, any>,
  screenshot?: string
): Promise<OrchestratorDecision> {
  // Build message content — include screenshot if available for visual verification
  const textContent = `OVERALL GOAL: ${overallGoal}

CURRENT SUB-GOAL TO EVALUATE: ${subGoal}

COMPLETED SUB-GOALS:
${completedGoals.length > 0 ? completedGoals.map((g, i) => `${i + 1}. ${g}`).join('\n') : '(none)'}

CURRENT SCREEN STATE (DOM):
${currentScreenDOM}

Based on the current screen, should we SKIP this sub-goal (already done), REWRITE it (adapt to current state), or PROCEED as-is?`;

  const messageContent: any[] = [];
  if (screenshot) {
    messageContent.push({ type: 'image', image: screenshot });
  }
  messageContent.push({ type: 'text', text: textContent });

  const { object } = await generateObject({
    model,
    schema: orchestratorSchema,
    system: ORCHESTRATOR_SYSTEM_PROMPT,
    ...(providerOptions ? { providerOptions } : {}),
    messages: [
      {
        role: 'user',
        content: screenshot ? messageContent : textContent,
      },
    ],
  });

  return object;
}

// ─── Screen readiness check ──────────────────────────────

const readinessSchema = z.object({
  ready: z.boolean().describe('Whether the screen is in a clean state ready for the next sub-goal'),
  issues: z
    .array(z.string())
    .describe(
      "List of issues preventing readiness (e.g., 'keyboard is visible', 'autocomplete dropdown open', 'dialog blocking')"
    ),
  suggestedAction: z
    .string()
    .optional()
    .describe(
      "Single action to resolve the most critical issue (e.g., 'tap the back button to dismiss keyboard', 'tap the suggestion to confirm input')"
    ),
});

export type ScreenReadiness = z.infer<typeof readinessSchema>;

/**
 * Assess whether the screen is in a clean state between sub-goals.
 * Detects leftover overlays, keyboards, autocomplete dropdowns, etc.
 * that should be resolved before starting the next sub-goal.
 */
export async function assessScreenReadiness(
  model: any,
  completedGoal: string,
  nextGoal: string,
  currentScreenDOM: string,
  providerOptions?: Record<string, any>,
  screenshot?: string
): Promise<ScreenReadiness> {
  const textContent = `JUST COMPLETED: ${completedGoal}
NEXT SUB-GOAL: ${nextGoal}

CURRENT SCREEN STATE (DOM):
${currentScreenDOM}

Is the screen ready for the next sub-goal? Check for:
1. Leftover overlays (autocomplete/suggestion dropdowns still visible)
2. Keyboard blocking important UI elements
3. Unconfirmed input (typed text not yet confirmed as chip/pill)
4. Unexpected dialogs or popups
5. Screen not showing the expected state after the completed goal`;

  const messageContent: any[] = [];
  if (screenshot) {
    messageContent.push({ type: 'image', image: screenshot });
  }
  messageContent.push({ type: 'text', text: textContent });

  try {
    const { object } = await generateObject({
      model,
      schema: readinessSchema,
      system: SCREEN_READINESS_PROMPT,
      ...(providerOptions ? { providerOptions } : {}),
      messages: [
        {
          role: 'user',
          content: screenshot ? messageContent : textContent,
        },
      ],
    });
    return object;
  } catch {
    return { ready: true, issues: [] };
  }
}

const SCREEN_READINESS_PROMPT = `You are a mobile automation screen readiness checker. Your job is to assess whether the device screen is in a CLEAN state, ready for the next sub-goal.

After each sub-goal completes, the screen may have leftover state that needs to be handled:
- Autocomplete/suggestion dropdowns still visible from typing
- Keyboard still open blocking UI elements needed for the next step
- Input not yet confirmed (raw text without chip/pill confirmation)
- Unexpected dialogs, popups, or overlays
- Screen showing an unexpected view

IMPORTANT:
- Study BOTH the DOM and screenshot (if provided) carefully
- A keyboard being visible is ONLY an issue if the next sub-goal needs elements that the keyboard covers
- An autocomplete dropdown is ALWAYS an issue — it means previous input wasn't confirmed
- Be specific about what you see — reference actual elements from the DOM
- The suggestedAction should be a SINGLE, specific action (not multi-step)

Return ready=true if the screen is clean and the next sub-goal can proceed.
Return ready=false with specific issues and a suggested action if cleanup is needed.`;

const ORCHESTRATOR_SYSTEM_PROMPT = `You are a mobile automation orchestrator. Your job is to evaluate whether a planned sub-goal is still relevant given the ACTUAL current screen state.

You will receive:
1. The overall goal the user wants to achieve
2. The current sub-goal about to be executed
3. Previously completed sub-goals
4. The current screen DOM (showing what's visible on the device right now)
5. A screenshot of the current screen (when available)

CRITICAL: Do NOT assume the screen matches what you'd expect after the completed sub-goals. LOOK at the actual DOM and screenshot to understand what the device is REALLY showing right now.

Your job is to decide ONE of three actions:

**skip** — The sub-goal is ALREADY achieved on the current screen. For example:
- Sub-goal is "Open Settings" but Settings is already open
- Sub-goal is "Navigate to WiFi settings" but WiFi settings are already visible
- Sub-goal is "Enter email address" but the address is already in the field

**rewrite** — The sub-goal needs adaptation because the screen state is different than expected. For example:
- Sub-goal is "Navigate to X" but X is already visible — rewrite to the actual action needed
- An overlay/dropdown/dialog is blocking the intended action — read the DOM, find the specific element to dismiss it, and include that in the rewritten goal
- Sub-goal no longer matches what's on screen — rewrite to match what actually needs to happen next
- The target element is not visible because a keyboard/overlay is covering it — rewrite to dismiss the blocker first

**proceed** — The sub-goal is still valid and should be executed as planned.

Rules:
- ALWAYS study the DOM AND screenshot (if provided) before deciding. The screenshot shows the REAL visual state.
- Read the DOM carefully to understand what screen the device is currently showing
- Check for blockers: Is a keyboard visible? Is an autocomplete dropdown open? Is a dialog showing?
- Be aggressive about skipping — if the screen already shows the desired state, skip
- When rewriting, make the new goal specific to what ACTUALLY needs to happen from the current screen
- CRITICAL: When rewriting, READ THE DOM and reference the SPECIFIC element to interact with by its text/desc from the DOM. Do NOT give vague instructions.
- NEVER rewrite a sub-goal to include work from ALREADY COMPLETED sub-goals. Only cover what THIS sub-goal needs to do.
- Keep rewritten goals concise, focused, and actionable — a small adaptation, not a full workflow rewrite.`;

// ─── Planner ───────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are a goal decomposition planner for a mobile automation agent.

Given a user's goal, break it into sequential, atomic sub-goals that the agent can execute one at a time.

Rules:
1. TRULY simple goals (single action, one tap/toggle) → isComplex: false
   Examples: "Open Settings", "Turn on WiFi", "Go home"
2. Everything else → isComplex: true, decompose into sub-goals
3. Each sub-goal should be ONE logical step (achievable in 3-8 agent actions)
4. Include the target app package name or bundle ID when known
5. Mark dependencies between sub-goals (dependsOn index)
6. Don't create redundant "Open App" sub-goals if the app is already implied by the first action
7. For messaging goals: separate "navigate to contact/chat" from "type message" from "send message"
8. For search goals: separate "open search" from "type query" from "select result"
9. IMPORTANT: When a sub-goal involves typing/entering text into a field, use the word "Type" explicitly (not "Enter" which is ambiguous). Example: "Type 'hello@email.com' into the To field" NOT "Enter hello@email.com in the recipient field"
10. FIELD-SPECIFIC SUB-GOALS: When a screen has multiple input fields, create a separate sub-goal for EACH field that needs to be filled. Always name the specific field in the sub-goal (e.g., "Type 'X' into the [field name] field"). NEVER say "Type into the field" without specifying WHICH field. The agent needs to know exactly which field to target.

Examples of SIMPLE goals (no decomposition needed):
- "Open Settings" → simple (single app launch)
- "Turn on WiFi" → simple (single toggle)
- "Go back" → simple (single action)

Examples of COMPLEX goals (MUST decompose):
- "Open WhatsApp and send message to Mom saying I'm waiting"
  → [
    { goal: "Launch WhatsApp", app: "com.whatsapp" },
    { goal: "Find and open Mom's chat", dependsOn: 0 },
    { goal: "Type 'I'm waiting' in the message field", dependsOn: 1 },
    { goal: "Tap the send button to send the message", dependsOn: 2 }
  ]
- "Search for cats on YouTube"
  → [
    { goal: "Launch YouTube", app: "com.google.android.youtube" },
    { goal: "Tap the search icon and type 'cats'", dependsOn: 0 },
    { goal: "Select a video from the search results", dependsOn: 1 }
  ]
- "Copy text from Notes and paste into WhatsApp to Mom"
  → [
    { goal: "Open Notes app and select the text to copy", app: "com.google.android.keep" },
    { goal: "Copy the selected text", dependsOn: 0 },
    { goal: "Open WhatsApp and navigate to Mom's chat", app: "com.whatsapp", dependsOn: 1 },
    { goal: "Paste the copied text and send", dependsOn: 2 }
  ]

IMPORTANT: When in doubt, decompose. Small focused sub-goals succeed far more often than large monolithic ones. The agent performs best when each sub-goal has a clear, verifiable completion condition.`;
