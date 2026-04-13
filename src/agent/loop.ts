/**
 * THE agentic while-loop — the core of AppClaw.
 *
 * Perception → Reasoning → Action loop with:
 * - Trimmed DOM sent directly to LLM (no intermediate element parsing)
 * - LLM calls appium-mcp tools directly with the right locators
 * - Recovery engine (checkpoint/rollback)
 * - Enhanced human-in-the-loop (typed HITL requests)
 * - Action recording
 */

import type { MCPClient } from '../mcp/types.js';
import { findElement, isMCPError, extractText } from '../mcp/tools.js';
import { typeViaKeyboard, detectDeviceUdid, pressEnterKey } from '../mcp/keyboard.js';
import type { LLMProvider, AgentContext, ToolCallDecision } from '../llm/provider.js';
import type { ActionResult } from '../llm/schemas.js';
import { getScreenState } from '../perception/screen.js';
import { diffScreen, computeScreenHash } from '../perception/screen-diff.js';
import { createStuckDetector } from './stuck.js';
import { createRecoveryEngine } from './recovery.js';
import { askUser, classifyHITLRequest } from './human-in-the-loop.js';
import { tapAtCoordinates, isAIElement, parseAIElementCoords } from './element-finder.js';
import { findElementByVision } from '../mcp/tools.js';
import { Config } from '../config.js';
import { isVisionLocateEnabled } from '../vision/locate-enabled.js';
import { getCachedScreenSize } from '../vision/window-size.js';
import type { ActionRecorder } from '../recording/recorder.js';
import type { AppResolver } from './app-resolver.js';
import { preprocessAction, resolveAppId } from './preprocessor.js';
import { activateAppWithFallback } from '../mcp/activate-app.js';
import { MODEL_PRICING } from '../constants.js';
import * as ui from '../ui/terminal.js';
import { EpisodicRecorder } from '../memory/recorder.js';
import { loadStore } from '../memory/store.js';
import { retrieveTrajectories, formatExperienceForPrompt } from '../memory/retriever.js';
import {
  extractScreenLabels,
  extractGoalKeywords,
  extractAppIdFromText,
} from '../memory/fingerprint.js';

const mcpDebug = process.env.MCP_DEBUG === '1' || process.env.MCP_DEBUG === 'true';

export interface AgentOptions {
  goal: string;
  /** Clean goal text for CLI display (without CONTEXT block). If omitted, uses goal. */
  displayGoal?: string;
  mcp: MCPClient;
  llm: LLMProvider;
  appResolver?: AppResolver;
  /** Known app package/bundle ID for episodic memory (set by orchestrator) */
  appId?: string;
  maxSteps?: number;
  stepDelay?: number;
  maxElements?: number;
  visionMode?: 'always' | 'fallback' | 'never';
  /** Optional recorder — pass to record actions for replay */
  recorder?: ActionRecorder;
  /** Model name for token cost calculation */
  modelName?: string;
  onStep?: (event: StepEvent) => void;
  /** Callback to evaluate screen state and potentially rewrite the goal mid-execution */
  screenEvaluator?: (
    currentDom: string,
    currentGoal: string,
    step: number
  ) => Promise<ScreenEvaluation | null>;
}

export interface ScreenEvaluation {
  /** Whether the goal should be adapted */
  adapt: boolean;
  /** The adapted goal text (if adapt=true) */
  adaptedGoal?: string;
  /** Whether the goal is already done */
  done?: boolean;
  /** Reason for the decision */
  reason: string;
}

export interface StepEvent {
  step: number;
  decision: ToolCallDecision;
  result: ActionResult;
  elementsCount: number;
  /** Base64 screenshot taken after the action (for IDE streaming) */
  screenshot?: string;
}

export interface AgentResult {
  success: boolean;
  reason: string;
  stepsUsed: number;
  history: StepRecord[];
  /** Aggregate token usage across all steps */
  totalTokens?: { input: number; output: number; cost: number };
}

export interface StepRecord {
  step: number;
  action: string;
  decision: ToolCallDecision;
  result: string;
  screenHash: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  let { goal } = options;
  const {
    mcp,
    llm,
    appResolver,
    maxSteps = 30,
    stepDelay = 500,
    maxElements = 80,
    visionMode = 'fallback',
    recorder,
    modelName = 'unknown',
    onStep,
    screenEvaluator,
  } = options;

  const stuck = createStuckDetector();
  const recovery = createRecoveryEngine();
  const history: StepRecord[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let prevDom = '';
  let lastResult = '';
  let detectedPlatform: 'android' | 'ios' = 'android';
  let postActionScreenshot: string | undefined; // Screenshot captured after previous action
  let cachedPostScreen: import('../perception/types.js').ScreenState | undefined; // Reuse post-action screen as next step's perception
  const triedSelectors: string[] = []; // Track selectors the LLM has tried (for stuck recovery)

  // ── Proactive negative cache ──────────────────────────
  // Tracks which selectors failed on which screen (by hash).
  // Injected into every LLM call so the model avoids repeating known-bad actions.
  const screenFailures = new Map<
    string,
    Array<{ selector: string; action: string; error: string }>
  >();

  // Detect device UDID for keyboard input (ADB-based typing on Android)
  const deviceUdid = await detectDeviceUdid();
  const agentSpinDetail = ui.formatAgentThinkingDetail(modelName);

  // ── Episodic Memory ──────────────────────────────────
  // Cross-session trajectory store: remembers winning actions from previous runs.
  const episodicEnabled = Config.EPISODIC_MEMORY === 'on';
  const episodicStorePath = Config.EPISODIC_MEMORY_PATH || undefined;
  const episodicRecorder = episodicEnabled
    ? new EpisodicRecorder(goal, detectedPlatform, Config.AGENT_MODE, episodicStorePath)
    : undefined;
  // Seed recorder with known app ID from orchestrator
  if (episodicRecorder && options.appId) {
    episodicRecorder.setAppId(options.appId);
  }
  const episodicStore = episodicEnabled ? loadStore(episodicStorePath) : undefined;
  const goalKeywords = episodicEnabled ? extractGoalKeywords(goal) : [];

  if (episodicEnabled) {
    const entryCount = episodicStore?.entries.length ?? 0;
    ui.printAgentBullet(`Episodic memory: ON (${entryCount} stored trajectories)`);
  }

  ui.printGoalStart(options.displayGoal ?? goal, maxSteps);

  // ─── 0. PRE-PROCESS: handle obvious actions without LLM ──
  if (appResolver) {
    try {
      const preResult = await preprocessAction(goal, mcp, appResolver);
      if (preResult.handled) {
        ui.printPreprocessor(preResult.message ?? '');
        lastResult = preResult.message ?? '';
        // Feed preprocessor result to episodic recorder for app ID detection
        if (episodicRecorder && lastResult) {
          const appIdFromResult = extractAppIdFromText(lastResult);
          if (appIdFromResult) episodicRecorder.setAppId(appIdFromResult);
        }
        await sleep(1500);
      }
    } catch (err) {
      ui.printWarning(`Preprocessor failed: ${err}`);
    }
  }

  for (let step = 0; step < maxSteps; step++) {
    if (step === 0) {
      ui.printAgentBullet('Pulling UI state from the device');
      ui.printAgentBullet('Consulting the agent model for the next action');
    }
    ui.startSpinner('Reasoning…', agentSpinDetail);

    // ─── 1. PERCEIVE ─────────────────────────────────────
    const captureScreenshot =
      visionMode === 'always' ||
      (visionMode === 'fallback' && llm.supportsVision) ||
      isVisionLocateEnabled() ||
      Config.AGENT_MODE === 'vision';

    const skipPageSource = Config.AGENT_MODE === 'vision';

    let screen;
    // Reuse the post-action screen from the previous step when available.
    // This eliminates a redundant getPageSource MCP call (~200-800ms).
    // Only reuse when the cached screen has DOM (not vision-only) or when
    // we're in vision mode (DOM not needed). Always fetch fresh on step 0.
    if (cachedPostScreen && step > 0) {
      screen = cachedPostScreen;
      cachedPostScreen = undefined;
    } else {
      try {
        screen = await getScreenState(
          mcp,
          maxElements,
          captureScreenshot,
          skipPageSource,
          !!recorder
        );
      } catch (err) {
        ui.stopSpinner();
        ui.printError(`Step ${step + 1}: Failed to get screen state`, String(err));
        lastResult = `Screen capture failed: ${err}`;
        cachedPostScreen = undefined; // Invalidate cache on failure
        continue;
      }
    }

    recorder?.setPlatform(screen.platform);
    detectedPlatform = screen.platform;

    const diff = diffScreen(prevDom, screen.dom);
    const screenHash = computeScreenHash(screen.dom);
    prevDom = screen.dom;

    // ─── 2. CHECKPOINT (on screen changes) ───────────────
    if (diff.changed) {
      recovery.checkpoint(
        step,
        screen.dom,
        history.map((h) => h.action)
      );
    }

    // ─── 2b. SCREEN-AWARE GOAL EVALUATION ────────────────
    // After a significant screen change, check if the goal needs adaptation.
    // Evaluates on every step including step 0 to catch stale state from previous sub-goal.
    if (screenEvaluator && diff.changed) {
      try {
        const evaluation = await screenEvaluator(screen.dom, goal, step);
        if (evaluation) {
          if (evaluation.done) {
            if (episodicRecorder) episodicRecorder.finalize(step + 1);
            ui.stopSpinner();
            ui.printGoalSuccess(step + 1, evaluation.reason);
            const pricing = MODEL_PRICING[modelName] ?? [0, 0];
            const cost =
              (totalInputTokens / 1_000_000) * pricing[0] +
              (totalOutputTokens / 1_000_000) * pricing[1];
            ui.printTokenSummary(
              totalInputTokens,
              totalOutputTokens,
              cost,
              modelName,
              totalCachedTokens
            );
            return {
              success: true,
              reason: evaluation.reason,
              stepsUsed: step + 1,
              history,
              totalTokens: { input: totalInputTokens, output: totalOutputTokens, cost },
            };
          }
          if (evaluation.adapt && evaluation.adaptedGoal) {
            // ── GUARDRAIL: Only allow overlay-dismissal adaptations ──
            // Reject any adaptation that tries to navigate, re-enter data, or redo work.
            // Only accept adaptations that handle overlays (tap a suggestion, dismiss a dialog).
            const adapted = evaluation.adaptedGoal;
            const adaptedLower = adapted.toLowerCase();
            const isNavigation =
              /\b(launch|open|go\s*back|compose\s*button|navigate|re-enter|start\s*over|redo|go\s*to)\b/i.test(
                adaptedLower
              );
            const isMultiStep =
              adapted.includes(', then ') ||
              adapted.includes(' and then ') ||
              adapted.split(',').length > 2;

            if (isNavigation || isMultiStep) {
              ui.stopSpinner();
              ui.printWarning(
                `Rejected adaptation: "${adapted.slice(0, 80)}" — keeping original goal`
              );
              ui.startSpinner('Reasoning…', agentSpinDetail);
            } else {
              ui.stopSpinner();
              ui.printInfo(`Goal adapted: ${adapted}`);
              goal = adapted;
              ui.startSpinner('Reasoning…', agentSpinDetail);
            }
          }
        }
      } catch {
        // Screen evaluation failed — continue with original goal
      }
    }

    // ─── 3. STUCK DETECTION + RECOVERY ───────────────────
    stuck.recordAction(history.at(-1)?.action ?? 'start', screenHash);
    let stuckHint: string | undefined;

    if (stuck.isStuck(goal)) {
      ui.stopSpinner();
      ui.printStuck(step + 1);

      const failedActions = history.slice(-3).map((h) => h.action);
      const alternatives = recovery.suggestAlternatives(failedActions);
      stuckHint = stuck.getRecoveryHint(goal);

      // Add DOM-aware hint showing untried interactive elements
      const domHint = stuck.getDOMRecoveryHint(goal, screen.dom, triedSelectors);
      stuckHint += '\n\n' + domHint;

      // iOS-specific navigation hints — iOS has no hardware back button
      if (detectedPlatform === 'ios') {
        stuckHint +=
          "\n\niOS HINT: There is NO hardware back button. To go back, look for a '< Back' or '< [label]' button in the top navigation bar, or use go_back (swipe from left edge). To dismiss overlays, look for 'Done', 'Cancel', or 'X' buttons.";
      }

      if (alternatives.length > 0) {
        stuckHint +=
          '\n\nSuggested alternatives:\n' + alternatives.map((a, i) => `${i + 1}. ${a}`).join('\n');
      }

      if (stuck.getStuckCount() >= 6) {
        ui.printRecovery('Attempting rollback...');
        const rollbackResult = await recovery.rollback(mcp);
        stuckHint += `\n\n${rollbackResult.message}`;
        stuck.reset();
      }
      ui.startSpinner('Reasoning…', agentSpinDetail);
    }

    // ─── 4. REASON (LLM call) ────────────────────────────
    // Use post-action screenshot from previous step if available (shows result of last action)
    // Otherwise use the screenshot captured during perception
    const screenshotForLLM =
      postActionScreenshot ?? (captureScreenshot ? screen.screenshot : undefined);
    postActionScreenshot = undefined; // Reset — will be set again after this step's action

    // ── Build proactive negative cache for this screen ──
    const failures = screenFailures.get(screenHash);
    let failedOnScreen: string | undefined;
    if (failures && failures.length > 0) {
      const failLines = failures
        .slice(-10) // Cap at 10 most recent failures on this screen
        .map((f) => `  ✗ ${f.action}("${f.selector}") → ${f.error}`)
        .join('\n');
      failedOnScreen = `FAILED ON THIS SCREEN (do NOT repeat these — they will fail again):\n${failLines}`;
    }

    // ── Episodic memory: retrieve past experience ──────
    let pastExperience: string | undefined;
    if (episodicStore && episodicRecorder) {
      episodicRecorder.setPlatform(screen.platform);
      episodicRecorder.detectAppIdFromDom(screen.dom);

      let screenLabels = extractScreenLabels(screen.dom);
      // In vision mode DOM is empty — use goal keywords as fallback (same as recorder)
      if (screenLabels.length === 0) screenLabels = goalKeywords;
      const matches = retrieveTrajectories(episodicStore, {
        platform: screen.platform,
        appId: episodicRecorder.currentAppId || '',
        currentScreenLabels: screenLabels,
        goalKeywords,
        agentMode: Config.AGENT_MODE,
      });

      if (matches.length > 0) {
        pastExperience = formatExperienceForPrompt(matches);
        episodicRecorder.trackInjectedTrajectories(matches);
        ui.printAgentBullet(
          `Episodic memory: injecting ${matches.length} past experience(s) (score: ${matches[0].score.toFixed(2)})`
        );
      }
    }

    const context: AgentContext = {
      goal,
      step,
      maxSteps,
      dom: screen.dom,
      screenshot: screenshotForLLM,
      lastResult: lastResult || undefined,
      screenChanges: diff,
      stuckHint,
      installedApps: step === 0 ? appResolver?.getAppListForContext() : undefined,
      platform: screen.platform,
      editableCount: screen.editableCount,
      failedOnScreen,
      pastExperience,
    };

    let decision: ToolCallDecision;
    let streamingStarted = false;
    const llmT0 = performance.now();
    try {
      decision = await llm.getDecision(context, {
        onTextStart() {
          streamingStarted = true;
          ui.stopSpinner();
          ui.startStreaming('Reasoning');
        },
        onTextChunk(text) {
          ui.streamChunk(text);
        },
        onDone() {
          ui.stopStreaming();
        },
      });
    } catch (err: any) {
      const errName = err?.name ?? '';
      const errMsg = err?.message ?? '';
      if (
        errName.includes('UnsupportedModel') ||
        errName.includes('AuthenticationError') ||
        errName.includes('API_KEY') ||
        errMsg.includes('API key') ||
        errMsg.includes('is not found') ||
        errMsg.includes('NOT_FOUND') ||
        err?.statusCode === 401 ||
        err?.statusCode === 404
      ) {
        ui.stopStreaming();
        ui.stopSpinner();
        ui.printError('Fatal LLM error', err.message ?? String(err));
        return {
          success: false,
          reason: `Fatal LLM error: ${err.message ?? err}`,
          stepsUsed: step + 1,
          history,
        };
      }
      ui.stopStreaming();
      ui.stopSpinner();
      ui.printError(`Step ${step + 1}: LLM error`, String(err));
      lastResult = `LLM call failed: ${err}`;
      continue;
    }

    // ─── 4b. LOG THE DECISION + TOKENS ──────────────────
    const llmElapsed = Math.round(performance.now() - llmT0);
    ui.stopSpinner();
    if (mcpDebug) {
      console.log(
        `        ${ui.theme.dim('llm')} ${ui.theme.info('getDecision')} ${ui.theme.dim(`${llmElapsed}ms`)}`
      );
    }

    // If reasoning text is available but wasn't streamed live, show it now
    if (decision.reasoning && !streamingStarted) {
      ui.printReasoning(decision.reasoning);
    }

    const argsSummary = formatArgs(decision);
    ui.printStep(step + 1, maxSteps, decision.toolName, argsSummary);

    if (decision.usage) {
      totalInputTokens += decision.usage.inputTokens;
      totalOutputTokens += decision.usage.outputTokens;
      totalCachedTokens += decision.usage.cachedTokens ?? 0;
      ui.printStepTokens(
        decision.usage.inputTokens,
        decision.usage.outputTokens,
        decision.usage.cachedTokens
      );
    }

    // ─── 4c. TRACK TRIED SELECTORS ─────────────────────
    if (decision.args.selector) {
      const sel = String(decision.args.selector);
      if (!triedSelectors.includes(sel)) {
        triedSelectors.push(sel);
        // Keep last 20 to avoid unbounded growth
        if (triedSelectors.length > 20) triedSelectors.shift();
      }
    }

    // ─── 5. DONE? ────────────────────────────────────────
    if (decision.toolName === 'done') {
      const reason = (decision.args.reason as string) ?? 'Goal completed';

      // ── Post-done verification ──────────────────────────
      // Guards against the LLM hallucinating goal completion.
      // Take a fresh screenshot and ask the LLM to verify the goal is actually achieved.
      // Only verify once per done attempt — if verification itself fails, trust the LLM.
      if (captureScreenshot && llm.supportsVision && step > 0) {
        try {
          await sleep(stepDelay);
          const verifyScreen = await getScreenState(mcp, maxElements, true, skipPageSource, false);
          if (verifyScreen.screenshot) {
            const verifyDecision = await llm.getDecision({
              goal:
                `VERIFICATION: The agent claims the goal "${goal}" is achieved because: "${reason}". ` +
                `Look at the screenshot carefully. Is the goal ACTUALLY achieved? ` +
                `If YES → call "done" with the same reason. ` +
                `If NO → call the appropriate action tool to continue working toward the goal. ` +
                `Be strict: if the keyboard is still covering the screen, if the expected content is not visible, ` +
                `or if the action clearly didn't complete, the goal is NOT achieved.`,
              step,
              maxSteps,
              dom: verifyScreen.dom,
              screenshot: verifyScreen.screenshot,
              lastResult: `Agent called done with reason: "${reason}". Verifying...`,
              screenChanges: {
                changed: false,
                addedCount: 0,
                removedCount: 0,
                summary: 'Verification step',
              },
              platform: detectedPlatform,
            });

            if (verifyDecision.usage) {
              totalInputTokens += verifyDecision.usage.inputTokens;
              totalOutputTokens += verifyDecision.usage.outputTokens;
              totalCachedTokens += verifyDecision.usage.cachedTokens ?? 0;
            }

            if (verifyDecision.toolName !== 'done') {
              // Verification rejected — the goal is NOT actually achieved
              ui.printWarning(`Done rejected by verification — continuing`);
              lastResult =
                `⚠️ VERIFICATION FAILED: You called "done" but the screenshot does NOT confirm the goal is achieved. ` +
                `Continue working toward the goal. Do NOT call "done" again until you have verified success visually.`;
              llm.feedToolResult(lastResult);
              // Use the verification's screenshot for the next step
              postActionScreenshot = verifyScreen.screenshot;
              cachedPostScreen = verifyScreen;
              history.push({
                step,
                action: 'done_rejected',
                decision,
                result: lastResult,
                screenHash,
              });
              continue; // Back to the top of the loop
            }
          }
        } catch {
          // Verification failed to execute — trust the LLM's original judgment
        }
      }

      // ── Episodic memory: save winning trajectories ─────
      if (episodicRecorder) {
        episodicRecorder.finalize(step + 1);
      }

      ui.printGoalSuccess(step + 1, reason);
      const pricing = MODEL_PRICING[modelName] ?? [0, 0];
      const cost =
        (totalInputTokens / 1_000_000) * pricing[0] + (totalOutputTokens / 1_000_000) * pricing[1];
      ui.printTokenSummary(totalInputTokens, totalOutputTokens, cost, modelName, totalCachedTokens);
      return {
        success: true,
        reason,
        stepsUsed: step + 1,
        history,
        totalTokens: { input: totalInputTokens, output: totalOutputTokens, cost },
      };
    }

    // ─── 6. HUMAN-IN-THE-LOOP? ───────────────────────────
    if (decision.toolName === 'ask_user') {
      const question = (decision.args.question as string) ?? 'Need input';
      const hitlRequest = classifyHITLRequest(question);
      const hitlResponse = await askUser(hitlRequest);

      if (hitlResponse.timedOut) {
        lastResult = 'User input timed out';
      } else if (hitlResponse.answered) {
        lastResult = `User answered: ${hitlResponse.answer}`;
      } else {
        lastResult = 'User provided no input';
      }

      llm.feedToolResult(lastResult);

      history.push({
        step,
        action: 'ask_user',
        decision,
        result: lastResult,
        screenHash,
      });

      recorder?.record(step, decision as any, screen.filtered, lastResult);
      continue;
    }

    // ─── 7. EXECUTE THE ACTION ───────────────────────────
    let result: ActionResult;

    if (isMetaTool(decision.toolName)) {
      result = await executeMetaTool(
        mcp,
        decision,
        appResolver,
        deviceUdid,
        detectedPlatform,
        screenshotForLLM
      );
    } else {
      // Forward directly to MCP — appium tools, skills, everything
      result = await executeMCPTool(mcp, decision);
    }

    lastResult = `${decision.toolName} → ${result.success ? 'OK' : 'FAILED'}: ${result.message}`;

    // ── Record failure in negative cache ──────────────────
    // Only track failures with a selector — these are the ones the LLM
    // would otherwise retry. Keyed by screen hash so failures are
    // scoped to the screen where they occurred.
    if (!result.success && decision.args.selector) {
      const sel = String(decision.args.selector);
      const existing = screenFailures.get(screenHash) ?? [];
      // Avoid duplicate entries for the same selector+action on this screen
      const isDuplicate = existing.some(
        (f) => f.selector === sel && f.action === decision.toolName
      );
      if (!isDuplicate) {
        existing.push({
          selector: sel,
          action: decision.toolName,
          error: result.message.slice(0, 80),
        });
        screenFailures.set(screenHash, existing);
      }

      // ── Episodic memory: mark stale if past experience failed ──
      if (episodicRecorder) {
        episodicRecorder.markFailedExperience(sel);
      }
    }

    // ── Episodic memory: record step ────────────────────
    if (episodicRecorder) {
      episodicRecorder.recordStep(screen.dom, decision.toolName, decision.args, result.success);
    }

    // When find_element succeeds, extract the UUID and make it prominent
    if (decision.toolName === 'appium_find_element' && result.success) {
      // Check for ai-element synthetic UUID first
      const aiMatch = result.message.match(/(ai-element:[^\s]+)/);
      if (aiMatch) {
        const coords = parseAIElementCoords(aiMatch[1]);
        if (coords) {
          lastResult += `\n>> AI_ELEMENT found at [${coords.x},${coords.y}]. Use appium_click with elementUUID="${aiMatch[1]}" or tap at these coordinates.`;
        }
      } else {
        const uuidMatch = result.message.match(
          /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
        );
        if (uuidMatch) {
          lastResult += `\n>> ELEMENT_UUID: ${uuidMatch[1]} — use this elementUUID in your NEXT tool call (appium_click, appium_set_value, etc). Do NOT call appium_find_element again.`;
        }
      }
    }

    // ─── 7b. POST-ACTION SCREEN VERIFICATION ──────────────
    // Always capture screenshot after action so the LLM can
    // visually verify the result and handle unexpected states.
    await sleep(stepDelay); // Wait for UI to settle
    try {
      const postScreen = await getScreenState(
        mcp,
        maxElements,
        captureScreenshot,
        skipPageSource,
        !!recorder
      );

      // Store screenshot for the next LLM turn — the LLM will SEE
      // the visual result of its action before deciding the next move
      if (postScreen.screenshot) {
        postActionScreenshot = postScreen.screenshot;
      }

      if (skipPageSource) {
        // ── Vision mode: no DOM diff, force LLM to verify via screenshot ──
        const wasTyping = decision.toolName === 'find_and_type';
        const wasClicking = decision.toolName === 'find_and_click';
        if (wasTyping) {
          lastResult += `\n>> ⛔ STOP. You just typed text. Before your next action, you MUST examine the screenshot:`;
          lastResult += `\n>>   1. Do you see a SUGGESTION DROPDOWN or CONTACT LIST? → You MUST tap the correct suggestion NOW.`;
          lastResult += `\n>>   2. Do you see a CHIP/PILL confirming the input? → Input is confirmed, you may call done.`;
          lastResult += `\n>>   3. Do you see the raw text still in the field with no confirmation? → Press ENTER to confirm.`;
          lastResult += `\n>>   You CANNOT call "done" unless the input is visually confirmed in the screenshot.`;
        } else if (wasClicking) {
          lastResult += `\n>> VERIFY: Look at the screenshot carefully after your tap:`;
          lastResult += `\n>>   1. Did the screen change SIGNIFICANTLY (e.g., navigated to a completely different screen)? → Your action likely SUCCEEDED. Check if your GOAL is now ACHIEVED — if yes, call "done" immediately.`;
          lastResult += `\n>>   2. Did the screen stay the SAME? → Your tap may have missed. Try again with a different description.`;
          lastResult += `\n>>   3. Did a dialog/popup/overlay appear? → Handle it first before proceeding.`;
        } else {
          lastResult += `\n>> VERIFY: Check the screenshot to confirm your action succeeded.`;
        }
      } else {
        // ── DOM mode: analyze DOM changes ──
        const postDiff = diffScreen(screen.dom, postScreen.dom);
        if (postDiff.changed) {
          lastResult += `\n>> SCREEN_AFTER_ACTION: ${postDiff.summary}`;
          const newTexts = extractNewElements(screen.dom, postScreen.dom);
          if (newTexts.length > 0) {
            lastResult += `\n>> NEW_ELEMENTS_APPEARED: ${newTexts.join(', ')}`;

            // After typing, new elements are likely autocomplete/suggestions that MUST be handled
            const wasTyping = decision.toolName === 'find_and_type';
            if (wasTyping) {
              lastResult += `\n>> ⛔ STOP — DO NOT call "done" yet. New elements appeared after typing. You MUST handle them first:`;
              lastResult += `\n>>   - Tap the correct suggestion/item from the dropdown`;
              lastResult += `\n>>   - OR press ENTER to confirm your input`;
              lastResult += `\n>>   - The goal is NOT complete until the overlay is dismissed.`;
            } else {
              lastResult += `\n>> IMPORTANT: Handle these new elements before proceeding. If suggestions/autocomplete appeared, tap the correct one. If a dialog/popup appeared, dismiss it.`;
            }
          }
        } else {
          lastResult += `\n>> SCREEN_AFTER_ACTION: No visible change — your action may have had no effect or succeeded silently.`;
        }
      }
      // Cache post-action screen for reuse as next step's perception.
      // Saves one getPageSource MCP round-trip (~200-800ms) per step.
      cachedPostScreen = postScreen;
    } catch {
      // Post-action capture failed — continue without cached screen
      cachedPostScreen = undefined;
    }

    // Feed tool result back into action history
    llm.feedToolResult(lastResult);

    if (result.success) {
      ui.printStepDetail(result.message);
    } else {
      ui.printStepError(result.message);
    }

    history.push({
      step,
      action: decision.toolName,
      decision,
      result: lastResult,
      screenHash,
    });

    recorder?.record(step, decision as any, screen.filtered, lastResult);

    onStep?.({
      step,
      decision,
      result,
      elementsCount: screen.elementCount,
      screenshot: postActionScreenshot,
    });
  }

  ui.printGoalFailed(`Max steps (${maxSteps}) reached`);
  const pricing = MODEL_PRICING[modelName] ?? [0, 0];
  const cost =
    (totalInputTokens / 1_000_000) * pricing[0] + (totalOutputTokens / 1_000_000) * pricing[1];
  ui.printTokenSummary(totalInputTokens, totalOutputTokens, cost, modelName);
  return {
    success: false,
    reason: 'Max steps reached',
    stepsUsed: maxSteps,
    history,
    totalTokens: { input: totalInputTokens, output: totalOutputTokens, cost },
  };
}

// ─── Meta-tool detection ──────────────────────────────────

const META_TOOLS = new Set([
  'find_and_click',
  'find_and_type',
  'launch_app',
  'go_back',
  'go_home',
  'press_enter',
]);

function isMetaTool(name: string): boolean {
  return META_TOOLS.has(name);
}

// ─── Meta-tool executor ───────────────────────────────────

async function executeMetaTool(
  mcp: MCPClient,
  decision: ToolCallDecision,
  appResolver?: AppResolver,
  deviceUdid?: string | null,
  platform: 'android' | 'ios' = 'android',
  /** Reusable screenshot from the current step (avoids redundant capture in vision locate) */
  currentScreenshot?: string
): Promise<ActionResult> {
  /**
   * Scale LLM-provided 0-1000 normalized coordinates to device space.
   * Uses the same scaleCoordinates() from df-vision that the playground uses —
   * guarantees identical coordinate handling across both paths.
   *
   * Note: df-vision convention is [y, x] order for coordinates.
   */
  async function scaleLLMCoords(tapX: number, tapY: number): Promise<{ x: number; y: number }> {
    const deviceSize = getCachedScreenSize(mcp);
    if (!deviceSize) {
      // Fallback: no device size, can't scale — return as-is (will likely miss)
      return { x: Math.round(tapX), y: Math.round(tapY) };
    }
    try {
      const starkVision = (await import('df-vision')).default;
      // scaleCoordinates expects [y, x] in 0-1000 normalized space
      const bbox = starkVision.scaleCoordinates([tapY, tapX] as [number, number], deviceSize);
      return { x: Math.round(bbox.center.x), y: Math.round(bbox.center.y) };
    } catch {
      // df-vision unavailable — simple fallback
      return {
        x: Math.round((tapX / 1000) * deviceSize.width),
        y: Math.round((tapY / 1000) * deviceSize.height),
      };
    }
  }

  try {
    const args = decision.args;

    switch (decision.toolName) {
      case 'find_and_click': {
        const isVisionMode = Config.AGENT_MODE === 'vision';
        // In vision mode, force ai_instruction regardless of what the LLM chose
        const strategy = isVisionMode ? 'ai_instruction' : (args.strategy as string);
        const selector = args.selector as string;
        const bounds = args.bounds as string | undefined;
        const tapX = args.tapX as number | undefined;
        const tapY = args.tapY as number | undefined;
        const attempts: string[] = [];

        if (isVisionMode) {
          // ══ VISION MODE: AI vision only, no DOM locators ══

          // Fast path: LLM provided 0-1000 normalized coordinates — skip vision locate entirely
          // Uses same scaleCoordinates() from df-vision as the playground
          if (tapX != null && tapY != null) {
            const scaled = await scaleLLMCoords(tapX, tapY);
            const tapped = await tapAtCoordinates(mcp, scaled.x, scaled.y);
            if (tapped) {
              if (mcpDebug)
                console.log(
                  `        [fast-tap] LLM (${Math.round(tapX)},${Math.round(tapY)}) → device (${scaled.x},${scaled.y}) — skipped vision locate`
                );
              return {
                success: true,
                message: `Clicked "${selector.slice(0, 60)}" via LLM coordinates at [${scaled.x},${scaled.y}]`,
              };
            }
            attempts.push(`llm_coords [${scaled.x},${scaled.y}]: tap failed`);
            // Fall through to vision locate as backup
          }

          if (isVisionLocateEnabled()) {
            try {
              const visionUuid = await findElementByVision(mcp, selector, currentScreenshot);
              // Pass the UUID (ai-element: or standard) directly to appium_click
              // appium-mcp handles ai-element: UUIDs natively with coordinate tapping
              const clickResult = await mcp.callTool('appium_click', { elementUUID: visionUuid });
              if (!isMCPError(clickResult)) {
                const coords = parseAIElementCoords(visionUuid);
                const coordInfo = coords ? ` at [${coords.x},${coords.y}]` : '';
                return {
                  success: true,
                  message: `Clicked "${selector.slice(0, 60)}" via AI vision${coordInfo}`,
                };
              }
              attempts.push('ai_vision: click failed');
            } catch (err) {
              attempts.push(
                `ai_vision: ${err instanceof Error ? err.message.slice(0, 60) : 'not found'}`
              );
            }
          }

          // Coordinate fallback
          if (bounds) {
            const coordMatch = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
            if (coordMatch) {
              const cx = Math.round((parseInt(coordMatch[1]) + parseInt(coordMatch[3])) / 2);
              const cy = Math.round((parseInt(coordMatch[2]) + parseInt(coordMatch[4])) / 2);
              const tapped = await tapAtCoordinates(mcp, cx, cy);
              if (tapped) {
                return {
                  success: true,
                  message: `Tapped "${selector.slice(0, 60)}" at coordinates [${cx},${cy}]`,
                };
              }
              attempts.push('coordinates: tap failed');
            }
          }

          return {
            success: false,
            message: `Vision failed for "${selector.slice(0, 60)}": ${attempts.join(', ')}`,
          };
        }

        // ══ DOM MODE: DOM locators first, vision as fallback ══

        // Strategy 1: Use the LLM's chosen strategy
        try {
          const uuid = await findElement(mcp, strategy as any, selector);
          const clickResult = await mcp.callTool('appium_click', { elementUUID: uuid });
          if (!isMCPError(clickResult)) {
            return { success: true, message: `Clicked "${selector.slice(0, 60)}" via ${strategy}` };
          }
          attempts.push(`${strategy}: click failed`);
        } catch {
          attempts.push(`${strategy}: not found`);
        }

        // Strategy 2: Try alternate ID strategies
        const fallbackStrategies: Array<{ s: string; v: string }> = [];
        if (strategy !== 'accessibility id') {
          fallbackStrategies.push({ s: 'accessibility id', v: selector });
        }
        if (strategy !== 'id') {
          fallbackStrategies.push({ s: 'id', v: selector });
        }

        for (const fb of fallbackStrategies) {
          try {
            const uuid = await findElement(mcp, fb.s as any, fb.v);
            const clickResult = await mcp.callTool('appium_click', { elementUUID: uuid });
            if (!isMCPError(clickResult)) {
              return {
                success: true,
                message: `Clicked "${selector.slice(0, 60)}" via fallback ${fb.s}`,
              };
            }
            attempts.push(`${fb.s}: click failed`);
          } catch {
            attempts.push(`${fb.s}: not found`);
          }
        }

        // Strategy 3: AI Vision fallback
        if (isVisionLocateEnabled()) {
          try {
            const visionUuid = await findElementByVision(mcp, selector, currentScreenshot);
            const clickResult = await mcp.callTool('appium_click', { elementUUID: visionUuid });
            if (!isMCPError(clickResult)) {
              const coords = parseAIElementCoords(visionUuid);
              const coordInfo = coords ? ` at [${coords.x},${coords.y}]` : '';
              return {
                success: true,
                message: `Clicked "${selector.slice(0, 60)}" via AI vision${coordInfo}`,
              };
            }
            attempts.push('ai_vision: click failed');
          } catch {
            attempts.push('ai_vision: not found');
          }
        }

        // Strategy 4: Coordinate fallback from bounds
        if (bounds) {
          const coordMatch = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
          if (coordMatch) {
            const cx = Math.round((parseInt(coordMatch[1]) + parseInt(coordMatch[3])) / 2);
            const cy = Math.round((parseInt(coordMatch[2]) + parseInt(coordMatch[4])) / 2);
            const tapped = await tapAtCoordinates(mcp, cx, cy);
            if (tapped) {
              return {
                success: true,
                message: `Tapped "${selector.slice(0, 60)}" at coordinates [${cx},${cy}]`,
              };
            }
            attempts.push('coordinates: tap failed');
          }
        }

        return {
          success: false,
          message: `All strategies failed for "${selector.slice(0, 60)}": ${attempts.join(', ')}`,
        };
      }

      case 'find_and_type': {
        const isVisionModeType = Config.AGENT_MODE === 'vision';
        // In vision mode, force ai_instruction regardless of what the LLM chose
        const strategy = isVisionModeType ? 'ai_instruction' : (args.strategy as string);
        const selector = args.selector as string;
        const text = (args.text as string) ?? '';
        const typeBounds = args.bounds as string | undefined;
        const typeTapX = args.tapX as number | undefined;
        const typeTapY = args.tapY as number | undefined;

        let uuid: string | null = null;
        let tappedViaVision = false;

        if (isVisionModeType) {
          // ══ VISION MODE: AI vision only ══

          // Fast path: LLM provided 0-1000 normalized coordinates — skip vision locate
          if (typeTapX != null && typeTapY != null) {
            const scaled = await scaleLLMCoords(typeTapX, typeTapY);
            const tapped = await tapAtCoordinates(mcp, scaled.x, scaled.y);
            if (tapped) {
              tappedViaVision = true;
              if (mcpDebug)
                console.log(
                  `        [fast-tap] LLM (${Math.round(typeTapX)},${Math.round(typeTapY)}) → device (${scaled.x},${scaled.y}) — skipped vision locate`
                );
            }
          }

          if (!tappedViaVision && isVisionLocateEnabled()) {
            try {
              const visionUuid = await findElementByVision(mcp, selector, currentScreenshot);
              // Use appium_click which natively handles ai-element: UUIDs
              const clickResult = await mcp.callTool('appium_click', { elementUUID: visionUuid });
              if (!isMCPError(clickResult)) {
                tappedViaVision = true;
              }
            } catch {
              /* continue */
            }
          }
        } else {
          // ══ DOM MODE: DOM locators first ══
          try {
            uuid = await findElement(mcp, strategy as any, selector);
          } catch {
            const fbStrategies = ['accessibility id', 'id'].filter((s) => s !== strategy);
            for (const fb of fbStrategies) {
              try {
                uuid = await findElement(mcp, fb as any, selector);
                break;
              } catch {
                /* continue */
              }
            }
          }

          // Vision fallback in DOM mode
          if (!uuid && isVisionLocateEnabled()) {
            try {
              const visionUuid = await findElementByVision(mcp, selector, currentScreenshot);
              const clickResult = await mcp.callTool('appium_click', { elementUUID: visionUuid });
              if (!isMCPError(clickResult)) {
                tappedViaVision = true;
              }
            } catch {
              /* continue */
            }
          }
        }

        // Coordinate fallback
        if (!uuid && !tappedViaVision && typeBounds) {
          const coordMatch = typeBounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
          if (coordMatch) {
            const cx = Math.round((parseInt(coordMatch[1]) + parseInt(coordMatch[3])) / 2);
            const cy = Math.round((parseInt(coordMatch[2]) + parseInt(coordMatch[4])) / 2);
            await tapAtCoordinates(mcp, cx, cy);
          }
        } else if (uuid) {
          // Click the found element to focus/navigate
          await mcp.callTool('appium_click', { elementUUID: uuid });
        } else if (!tappedViaVision) {
          return {
            success: false,
            message: `Could not find element "${selector.slice(0, 60)}" with any strategy`,
          };
        }

        // Brief delay — clicking often triggers screen transitions
        await sleep(500);

        // Get the active (focused) element — useful for clear and iOS set_value
        const activeUuid = await getActiveElementUuid(mcp);

        // Clear existing text if we have an active element
        if (activeUuid) {
          await mcp.callTool('appium_clear_element', { elementUUID: activeUuid }).catch(() => {});
        }

        // Always use W3C Actions — works on local and cloud, Android and iOS
        {
          const setResult = await mcp
            .callTool('appium_set_value', {
              text,
              w3cActions: true,
            })
            .catch(() => null);
          if (setResult && !isMCPError(setResult)) {
            return {
              success: true,
              message: `Typed "${text}" into "${selector.slice(0, 60)}". NOTE: Check the screen — if autocomplete suggestions appeared, tap the correct one or press Enter to confirm before proceeding.`,
            };
          }
        }

        return {
          success: false,
          message:
            `Could not type "${text}" into "${selector.slice(0, 60)}". ` +
            (platform === 'android'
              ? 'ADB keyboard input and appium_set_value both failed.'
              : 'appium_set_value failed on active element.'),
        };
      }

      case 'launch_app': {
        let appId = (args.appId as string) ?? '';
        if (!appId) {
          return { success: false, message: 'No appId provided for launch_app' };
        }
        if (appResolver && !appId.includes('.')) {
          const resolved = resolveAppId(appId, appResolver);
          if (resolved) appId = resolved;
        }
        ui.printStepDetail(`activateApp("${appId}")`);
        const launched = await activateAppWithFallback(mcp, appId);
        return {
          success: launched.success,
          message: launched.success ? `Launched ${appId}` : launched.message,
        };
      }

      case 'go_back':
        await mcp.callTool('appium_mobile_press_key', { key: 'BACK' });
        return { success: true, message: 'Went back' };

      case 'go_home':
        await mcp.callTool('appium_mobile_press_key', { key: 'HOME' });
        return { success: true, message: 'Went home' };

      case 'press_enter': {
        // Strategy 1: ADB keyevent (most reliable on Android)
        if (platform === 'android') {
          const enterResult = await pressEnterKey(deviceUdid ?? undefined);
          if (enterResult.success) {
            return { success: true, message: 'Pressed Enter' };
          }
        }
        // Strategy 2: Appium execute script fallback
        try {
          await mcp.callTool('appium_execute_script', {
            script: 'mobile: shell',
            args: [{ command: 'input', args: ['keyevent', '66'] }],
          });
          return { success: true, message: 'Pressed Enter' };
        } catch {
          return {
            success: false,
            message: 'Failed to press Enter — both ADB and Appium script failed',
          };
        }
      }

      default:
        return { success: false, message: `Unknown meta-tool: ${decision.toolName}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.printError(`Meta-tool "${decision.toolName}" failed`, message);
    return { success: false, message };
  }
}

// ─── Dynamic MCP tool executor ────────────────────────────

/**
 * Forward any tool call directly to the MCP server.
 * No hardcoded tool names — whatever the LLM calls, we forward.
 */
async function executeMCPTool(mcp: MCPClient, decision: ToolCallDecision): Promise<ActionResult> {
  try {
    const result = await mcp.callTool(decision.toolName, decision.args);
    const text =
      result.content
        ?.map((c: any) => (c.type === 'text' ? c.text : ''))
        .filter(Boolean)
        .join(' ') ?? '';

    const isError =
      text.toLowerCase().includes('error') ||
      text.toLowerCase().includes('failed') ||
      text.toLowerCase().includes('not found');

    return {
      success: !isError,
      message: text.slice(0, 200) || `${decision.toolName} executed`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.printError(`MCP tool "${decision.toolName}" failed`, message);
    return { success: false, message };
  }
}

// ─── Logging helper ───────────────────────────────────────

function formatArgs(decision: ToolCallDecision): string {
  const args = decision.args;
  const parts: string[] = [];

  const visionUi =
    Config.AGENT_MODE === 'vision' &&
    (decision.toolName === 'find_and_click' || decision.toolName === 'find_and_type');
  if (visionUi && args.selector) {
    const s = String(args.selector);
    const short = s.length > 90 ? `${s.slice(0, 90)}…` : s;
    parts.push(`vision="${short}"`);
  } else if (args.strategy && args.selector) {
    parts.push(`${args.strategy}="${args.selector}"`);
  }
  if (args.elementUUID) parts.push(`uuid=${(args.elementUUID as string).slice(-8)}`);
  if (args.appId) parts.push(`app="${args.appId}"`);
  if (args.text) parts.push(`text="${args.text}"`);
  if (args.direction) parts.push(`${args.direction}`);
  if (args.reason) parts.push(`(${args.reason})`);
  if (args.question) parts.push(`"${args.question}"`);
  if (args.key) parts.push(`key="${args.key}"`);
  if (args.id) parts.push(`id="${args.id}"`);

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

// ─── Post-action screen analysis ───────────────────────────

/**
 * Extract text of new elements that appeared after an action.
 * Compares two trimmed DOMs to find what's new.
 */
function extractNewElements(beforeDom: string, afterDom: string): string[] {
  const textRegex = /text="([^"]+)"/g;
  const descRegex = /desc="([^"]+)"/g;

  const beforeTexts = new Set<string>();
  let match;
  while ((match = textRegex.exec(beforeDom)) !== null) beforeTexts.add(match[1]);
  while ((match = descRegex.exec(beforeDom)) !== null) beforeTexts.add(match[1]);

  // Reset regex lastIndex
  textRegex.lastIndex = 0;
  descRegex.lastIndex = 0;

  const newElements: string[] = [];
  while ((match = textRegex.exec(afterDom)) !== null) {
    if (!beforeTexts.has(match[1]) && match[1].length > 1) newElements.push(match[1]);
  }
  while ((match = descRegex.exec(afterDom)) !== null) {
    if (!beforeTexts.has(match[1]) && match[1].length > 1) newElements.push(match[1]);
  }

  // Deduplicate and limit
  return [...new Set(newElements)].slice(0, 8);
}

// ─── Active element helper ─────────────────────────────────

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Get the UUID of the currently focused element.
 * Returns null if no active element or the call fails.
 */
async function getActiveElementUuid(mcp: MCPClient): Promise<string | null> {
  const result = await mcp.callTool('appium_get_active_element', {}).catch(() => null);
  if (!result || isMCPError(result)) return null;
  const match = extractText(result).match(UUID_RE);
  return match ? match[1] : null;
}
