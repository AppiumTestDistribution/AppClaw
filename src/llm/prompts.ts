/**
 * System and user prompt builders for the agent loop.
 *
 * Single unified prompt for both DOM and Vision modes.
 * Mode-specific sections are injected via buildSystemPrompt().
 */

import type { AgentContext } from './provider.js';
/** Unified mobile agent system prompt — works for both DOM and Vision modes */
const BASE_AGENT_PROMPT = `You are a Mobile Device Agent controlling a device via Appium. Your job is to achieve the user's goal by navigating the mobile UI.

You will receive:
1. GOAL — the user's task
2. STEP — current step number / max steps
3. SCREENSHOT — image of the CURRENT screen state AFTER your last action (when available). ALWAYS study this image carefully before deciding your next action.
4. LAST_ACTION_RESULT — outcome of your previous action

You MUST call exactly one tool per turn.`;

/** DOM mode: how to locate elements using DOM attributes */
const DOM_INTERACTION = `
═══════════════════════════════════════════
HOW TO INTERACT (DOM MODE)
═══════════════════════════════════════════

**To tap an element:** Use find_and_click(strategy, selector) — finds and clicks in ONE step.
**To type into a field:** Use find_and_type(strategy, selector, text) — finds, clicks, clears, and types in ONE step.

**Locator strategies:**

1. **accessibility id** (PREFERRED): Pass the element's desc or name value.
   Example: strategy="accessibility id", selector="Network & internet"

2. **id** (second choice): Pass the element's full rid value INCLUDING the package prefix.
   Example: strategy="id", selector="com.google.android.gm:id/compose_button"

**How to pick:** Look at the DOM element:
- Has desc="X"? → Use accessibility id with "X"
- Has rid="Y"? → Use id with "Y"
- Has only text="Z"? → Use accessibility id with "Z"

**IMPORTANT:** Include the bounds parameter from the DOM as a fallback. Copy it exactly, e.g. bounds="[100,200][300,400]".

**Reading the DOM:**
DOM is a flat list of <ElementType .../> tags. Key attributes:
- text / desc / rid — element identifiers for locator strategies
- hint — placeholder text in input fields
- bounds — position [x1,y1][x2,y2]
- clickable="true" / editable="true" / enabled="false" / focused="true"`;

/** Vision mode: how to locate elements using visual descriptions */
const VISION_INTERACTION = `
═══════════════════════════════════════════
HOW TO INTERACT (VISION MODE)
═══════════════════════════════════════════

**To tap an element:** Use find_and_click and describe what you SEE.
  Example: find_and_click(selector="round button with pencil icon at bottom right")
  Example: find_and_click(selector="Send arrow icon in the top toolbar")

**To type into a field:** Use find_and_type and describe the field.
  Example: find_and_type(selector="text input field labeled 'To' at the top", text="user@example.com")
  Example: find_and_type(selector="large text area below the subject line", text="Hello")

**SPEED BOOST — provide tap coordinates:**
If you can estimate WHERE the element is in the screenshot, include tapX and tapY.
Use normalized 0-1000 scale: (0,0) is top-left, (1000,1000) is bottom-right.
This skips the separate vision-locate step and executes the action much faster.
  Example: find_and_click(selector="search icon top right", tapX=950, tapY=70)
  Example: find_and_type(selector="search bar at center top", text="hello", tapX=500, tapY=120)
The system handles scaling to device coordinates. If your coordinates miss, it falls back to vision locate.

**Writing good descriptions** — be specific about:
- Visible text: "button labeled 'Send'", "field with hint 'Subject'"
- Appearance: "blue round button", "red X icon", "paper plane icon"
- Position: "top right corner", "bottom center", "below the To field"
- Context: "icon next to the profile picture"

**Bad descriptions (will fail):** "the button", "input field", "that icon"`;

/** Shared rules for both modes */
const SHARED_RULES = `
═══════════════════════════════════════════
RULES
═══════════════════════════════════════════

1. VERIFY BEFORE DECIDING — before EVERY action, study the screenshot. Ask yourself: "What do I see? What changed? Is there something I need to handle first?" Only then choose your next action.
2. ONE STEP AT A TIME — do the NEXT logical step only. Don't skip ahead.
3. AFTER TYPING — after find_and_type, your NEXT action must be based on what the screenshot shows:
   - Suggestion/dropdown visible? → TAP the correct suggestion. Not done yet.
   - Chip/pill created (input confirmed)? → You can proceed or call done.
   - Raw text with no confirmation? → Press ENTER or tap elsewhere to confirm.
   - NEVER call "done" right after typing. Always verify first.
4. AFTER TAPPING — after find_and_click, check: did the screen change? If it looks the same, your tap may have missed. Try a different description.
5. OVERLAYS — if anything is covering the screen (dialog, popup, dropdown, suggestions), handle it FIRST.
6. NO REPETITION — if an action failed, try something DIFFERENT. Never repeat the same failing action.
7. GO_BACK — only for dismissing popups or intentional navigation. Never mid-form — it discards your data.
8. DONE — only when the goal is fully achieved AND verified in the screenshot.
9. STAY FOCUSED — only your current goal. Ignore pending sub-goals.
10. FIELD TARGETING — identify each field by its label/hint/position. Type into the correct one.

═══════════════════════════════════════════
PROBLEM-SOLVING
═══════════════════════════════════════════

- Element not found → try a different description or strategy
- Screen didn't change after action → your action had no effect, try differently
- Suggestions appeared → tap the correct one, do NOT call done
- Expected elements missing → an overlay may be covering them, dismiss it
- Stuck → study the screenshot carefully, try elements you haven't tried yet`;

export function buildSystemPrompt(
  platform: 'android' | 'ios',
  aiVisionEnabled?: boolean,
  agentMode?: 'dom' | 'vision',
  /** Meta-tools + MCP tools actually registered for this run (matches generateText `tools`) */
  callableToolCount = 0
): string {
  const platformName = platform === 'android' ? 'Android' : 'iOS';
  const appIdLabel = platform === 'android' ? 'package name' : 'bundle ID';
  const isVision = agentMode === 'vision';

  // Do NOT paste MCP tool descriptions here — generateText() already sends full JSON schemas
  // for every tool (large). Duplicating them in the system prompt wasted ~multi-k tokens per step.

  // Mode-specific interaction section
  const interactionSection = isVision ? VISION_INTERACTION : DOM_INTERACTION;

  // Tools section
  const toolsSection = isVision
    ? `
**Primary tools — use strategy="ai_instruction" with a visual description:**
- find_and_click: Visually find + click in one step.
- find_and_type: Visually find + click + type text in one step.`
    : `
**Primary tools:**
- find_and_click: Find element + click in one step (strategy + selector).
- find_and_type: Find element + click + type text in one step (strategy + selector + text).`;

  // Vision fallback section for DOM mode
  const visionFallback =
    !isVision && aiVisionEnabled
      ? `

**AI Vision fallback:** When accessibility id and id both fail, you can use strategy="ai_instruction"
with a visual description as the selector. This uses AI vision to find the element on screen.
Example: find_and_click(strategy="ai_instruction", selector="blue Send button at bottom right")`
      : '';

  // iOS-specific navigation hints
  const iosNavigationHints =
    platform === 'ios'
      ? `
- iOS has NO hardware back button. To go back: tap the "< Back" / "Back" button in the navigation bar, or swipe from the left edge.
- go_back sends a swipe-from-left-edge gesture on iOS.
- Dismiss keyboards by tapping outside the input field or tapping "Done"/"Return".
- Home screen: swipe up from the bottom edge.`
      : '';

  return `${BASE_AGENT_PROMPT}
${interactionSection}
${SHARED_RULES}

═══════════════════════════════════════════
PLATFORM: ${platformName}
═══════════════════════════════════════════

Use ${appIdLabel} for launch_app.${iosNavigationHints}

═══════════════════════════════════════════
AVAILABLE TOOLS
═══════════════════════════════════════════
${toolsSection}
- launch_app: Open an app by ${appIdLabel}
- go_back: Press Back
- go_home: Press Home
- press_enter: Press Enter/Return key (submit search, confirm input, dismiss keyboard)
- done: Signal goal completion
- ask_user: Request human input

**Callable tools** (${callableToolCount} total — meta-tools above + Appium MCP). Each tool’s JSON schema is attached by the runtime; use it for arguments. Prefer find_and_click / find_and_type when they cover the action.${visionFallback}

When RELEVANT PAST EXPERIENCE is provided, prefer those strategies — they worked before in similar situations. But always verify they still apply to the current screen before using them. If a past strategy fails, try alternatives.`;
}

export function buildUserMessage(context: AgentContext): string {
  const parts: string[] = [];

  parts.push(`GOAL: ${context.goal}`);
  parts.push(`STEP: ${context.step + 1} / ${context.maxSteps}`);

  if (context.lastResult) {
    parts.push(`LAST_ACTION_RESULT: ${context.lastResult}`);
  }

  if (context.screenChanges) {
    parts.push(`SCREEN_CHANGE: ${context.screenChanges.summary}`);
  }

  if (context.stuckHint) {
    parts.push(`\n⚠️ ${context.stuckHint}`);
  }

  // ── Proactive negative cache ──────────────────────────
  // Inject failed selectors for the current screen BEFORE the DOM,
  // so the LLM sees what NOT to try before reading available elements.
  if (context.failedOnScreen) {
    parts.push(`\n${context.failedOnScreen}`);
  }

  // ── Episodic memory: past experience ─────────────────
  // Inject relevant trajectories from previous successful runs
  // BEFORE the DOM so the LLM sees proven strategies first.
  if (context.pastExperience) {
    parts.push(`\n${context.pastExperience}`);
  }

  // ── Contextual hints ──────────────────────────────────
  // Targeted micro-reminders based on current state. Additive only —
  // these reinforce existing rules when they matter most.
  const hints = buildContextualHints(context);
  if (hints) {
    parts.push(`\n${hints}`);
  }

  if (context.installedApps) {
    parts.push(
      `\nINSTALLED_APPS (use exact package names for "launch_app"):\n${context.installedApps}`
    );
  }

  // Include DOM only if available (skipped in vision mode)
  if (context.dom) {
    parts.push(`\nDOM:\n${context.dom}`);
  }

  parts.push(
    `\n⚡ Is the goal "${context.goal}" ALREADY achieved based on what you see? If yes, call "done".`
  );

  return parts.join('\n');
}

/**
 * Build contextual micro-hints based on current agent state.
 *
 * These are small, targeted reminders (1-2 lines) injected only when
 * specific conditions are met. They reinforce existing system prompt rules
 * at the exact moment they're most relevant — never remove or replace rules.
 */
function buildContextualHints(context: AgentContext): string {
  const hints: string[] = [];

  // Low on steps — push toward decisive action
  const stepRatio = (context.step + 1) / context.maxSteps;
  if (stepRatio > 0.7) {
    const remaining = context.maxSteps - context.step - 1;
    hints.push(
      `⏳ LOW ON STEPS (${remaining} left) — prioritize direct actions. If the goal looks achieved, call "done" now.`
    );
  }

  // Multiple editable fields on screen — reinforce field targeting
  // Uses pre-computed count from dom-trimmer (no redundant regex scan)
  if (context.editableCount && context.editableCount >= 3) {
    hints.push(
      `📝 MULTIPLE INPUT FIELDS (${context.editableCount}) — target each by its specific label, hint, or rid. Do not type into the wrong field.`
    );
  }

  return hints.join('\n');
}
