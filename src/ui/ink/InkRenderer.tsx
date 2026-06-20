/**
 * InkRenderer — implements the UIRenderer seam by translating each imperative
 * `ui.*` call from the agent loop into a UIStore mutation, and owns the Ink
 * render lifecycle (activate/deactivate around a run).
 *
 * Activated only on an interactive TTY (never in --json / SDK / piped output);
 * the plain console renderer in terminal.ts stays the default everywhere else.
 */

import React from 'react';
import { render, type Instance } from 'ink';
import { RunScreen, TranscriptStatic } from './RunScreen.js';
import { store } from './store.js';
import { toolToActionType, toolToVerb } from './theme.js';
import { setRenderer, type UIRenderer } from '../renderer.js';
import type { HITLRequest, HITLResponse } from '../../agent/human-in-the-loop.js';

let instance: Instance | null = null;

// ── Alternate-screen management (fullscreen fixed footer) ──
const ALT_ENTER = '\x1b[?1049h\x1b[2J\x1b[H'; // alt buffer, clear, home
const ALT_LEAVE = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
let altActive = false;
let sigintHandler: (() => void) | null = null;

function enterAlt(): void {
  if (altActive) return;
  process.stdout.write(ALT_ENTER + CURSOR_HIDE);
  altActive = true;
}

function leaveAlt(): void {
  if (!altActive) return;
  process.stdout.write(ALT_LEAVE + CURSOR_SHOW);
  altActive = false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extract a human target string from terminal.ts-style argsSummary. */
function parseTarget(toolName: string, argsSummary: string): string {
  const vision = argsSummary.match(/vision="([^"]+)"/)?.[1];
  const selector = argsSummary.match(/selector="([^"]+)"/)?.[1];
  const text = argsSummary.match(/text="([^"]+)"/)?.[1];

  if (toolName === 'find_and_type') {
    const tgt = vision || selector || 'field';
    return text ? `"${text}" → ${tgt}` : tgt;
  }
  if (toolName === 'done') {
    return argsSummary.match(/reason="([^"]+)"/)?.[1] || argsSummary.replace(/^reason=/, '');
  }
  return vision || selector || argsSummary;
}

const inkRenderer: UIRenderer = {
  printGoalStart(goal, maxSteps) {
    store.startSubGoal(goal, maxSteps);
  },

  printPlan(subGoals, reasoning) {
    store.plan(
      subGoals.map((s) => s.goal),
      reasoning
    );
  },

  printPlanContext(overallGoal, currentGoal, allGoals, currentIndex) {
    store.setSubGoal(currentIndex, allGoals.length, overallGoal, currentGoal);
  },
  printOrchestratorProceed() {
    // The sub-goal divider + bottom bar already convey advancement — no extra line.
  },
  printOrchestratorSkip(subGoal, reason) {
    store.log('info', `Skipped: ${subGoal}`, reason);
  },
  printOrchestratorRewrite(_original, rewritten) {
    store.log('info', `Adapted → ${rewritten}`);
  },

  printStep(step, maxSteps, toolName, argsSummary) {
    // commit any half-open step first
    store.endStep();
    store.beginStep(
      step,
      maxSteps,
      toolToVerb(toolName),
      toolToActionType(toolName),
      parseTarget(toolName, argsSummary)
    );
  },
  printStepDetail(message) {
    store.setStepDetail(message, 'done');
    store.endStep();
  },
  printStepError(message) {
    store.setStepDetail(message, 'failed');
    store.endStep();
  },
  printStepTokens(input, output, cached, cost) {
    store.setStepTokens(input, output, cached, cost);
    store.addTokens(input, output, cached ?? 0, cost ?? 0); // running footer total
  },

  printGoalSuccess(steps, reason) {
    store.finish({ status: 'success', reason, steps });
  },
  printGoalFailed(reason) {
    store.finish({ status: 'failed', reason, steps: 0 });
  },
  printTokenSummary(totalInput, totalOutput, cost, modelName, totalCached) {
    store.summary({
      input: totalInput,
      output: totalOutput,
      cached: totalCached ?? 0,
      cost,
      model: modelName,
    });
  },
  printJourneySummary(data) {
    store.journey(data);
  },

  startSpinner(message, detail) {
    store.startThinking(message, detail);
  },
  updateSpinner(message, detail) {
    store.updateThinking(message, detail);
  },
  stopSpinner() {
    store.stopThinking();
  },
  startStreaming(label = 'Reasoning') {
    store.startStreaming(label);
  },
  streamChunk(text) {
    store.streamChunk(text);
  },
  stopStreaming() {
    store.stopStreaming();
  },
  printReasoning(text) {
    store.log('reasoning', text);
  },

  printAgentBullet(message) {
    store.log('bullet', message);
  },
  printInfo(message) {
    store.log('info', message);
  },
  printWarning(message) {
    store.log('warn', message);
  },
  printError(message, detail) {
    store.log('error', message, detail);
  },
  printStuck(step) {
    store.log('stuck', `Stuck at step ${step}`);
  },
  printRecovery(message) {
    store.log('recovery', message);
  },
  printPreprocessor(message) {
    store.log('preprocessor', message);
  },
  printScreenReadiness(issues, suggestedAction) {
    store.log('warn', 'Screen not ready', [...issues, suggestedAction].filter(Boolean).join('; '));
  },

  // ── Flow / replay / explorer ──
  printReplayGoal(goal, totalSteps) {
    store.setGoal(goal, totalSteps);
  },
  printReplayStep(step, total, toolName, adapted, success) {
    store.pushStep(
      step,
      total,
      toolToVerb(toolName),
      toolToActionType(toolName),
      adapted ? 'adapted' : '',
      success ? 'done' : 'failed'
    );
  },
  printReplayResult(passed, total, adapted) {
    store.finish({
      status: passed === total ? 'success' : 'failed',
      reason: `${passed}/${total} steps passed${adapted > 0 ? ` (${adapted} adapted)` : ''}`,
      steps: total,
    });
  },
  printFlowStep(step, total, label, success) {
    store.pushStep(step, total, '', 'tool_call', label, success ? 'done' : 'failed');
  },
  printExplorerPhase(phase, message) {
    store.log('info', `${phase} — ${message}`);
  },
};

/**
 * Prompt the user through the Ink UI (used by human-in-the-loop while Ink owns
 * stdin). Mirrors the readline `askUser` semantics: numeric option mapping and
 * optional timeout.
 */
export function askUserViaInk(request: HITLRequest): Promise<HITLResponse> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (res: HITLResponse) => {
      if (timer) clearTimeout(timer);
      store.clearHitl();
      resolve(res);
    };

    if (request.timeout && request.timeout > 0) {
      timer = setTimeout(() => {
        store.log('warn', 'Timed out waiting for input');
        finish({ answered: false, answer: '', timedOut: true });
      }, request.timeout);
    }

    store.askHitl(request, (answer: string) => {
      const trimmed = answer.trim();
      if (request.options && /^\d+$/.test(trimmed)) {
        const idx = parseInt(trimmed, 10) - 1;
        if (idx >= 0 && idx < request.options.length) {
          return finish({ answered: true, answer: request.options[idx], timedOut: false });
        }
      }
      finish({ answered: !!trimmed, answer: trimmed, timedOut: false });
    });
  });
}

/** True when the current process should drive the Ink UI. */
export function shouldUseInk(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** Mount the Ink agent-loop UI and register it as the active renderer. */
export function activateInk(ctx?: {
  overallGoal?: string;
  subGoalTotal?: number;
  model?: string;
  mode?: string;
  /** Show per-step rows (default true). Agent mode passes the debug flag. */
  showSteps?: boolean;
}): void {
  if (instance) return;
  try {
    store.reset();
    if (ctx) {
      const { showSteps, ...runCtx } = ctx;
      store.setRunContext(runCtx);
      if (showSteps !== undefined) store.setShowSteps(showSteps);
    }
    // Fullscreen (pinned footer, scrolling viewport) on interactive TTYs, but
    // NOT when EITHER debug flag is set — both emit raw console.logs (MCP traffic
    // or AppClaw internals) that would corrupt the alternate screen, so debug
    // falls back to scrollback rendering.
    const anyDebug =
      process.env.MCP_DEBUG === '1' ||
      process.env.MCP_DEBUG === 'true' ||
      process.env.APPCLAW_DEBUG === '1' ||
      process.env.APPCLAW_DEBUG === 'true';
    const fullscreen =
      !anyDebug &&
      process.env.APPCLAW_FULLSCREEN !== 'off' &&
      !!process.stdout.isTTY &&
      (process.stdout.rows ?? 0) > 0;
    store.setFullscreen(fullscreen);
    if (fullscreen) {
      // Alt screen so the run doesn't pollute scrollback mid-flight; the full
      // transcript is dumped back on exit.
      enterAlt();
      sigintHandler = () => {
        leaveAlt();
        process.exit(130);
      };
      process.on('SIGINT', sigintHandler);
    }
    instance = render(<RunScreen />, {
      patchConsole: !fullscreen,
      exitOnCtrlC: !fullscreen,
    });
    setRenderer(inkRenderer);
  } catch {
    // If Ink can't mount (odd terminal, no raw mode), stay on plain output.
    leaveAlt();
    instance = null;
    setRenderer(null);
  }
}

/**
 * Unmount the Ink UI, leave the alternate screen, and reprint the full
 * transcript (incl. the final summary) to normal scrollback so it persists.
 */
export async function deactivateInk(): Promise<void> {
  setRenderer(null);
  if (sigintHandler) {
    process.removeListener('SIGINT', sigintHandler);
    sigintHandler = null;
  }
  if (instance) {
    const i = instance;
    instance = null;
    const wasFullscreen = altActive;
    i.unmount();
    leaveAlt();
    // Restore stdin so the process can exit cleanly.
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {
      /* ignore */
    }
    // In fullscreen the alt screen is cleared on exit, so reprint the committed
    // transcript to normal scrollback (Static flushes on mount; give it a tick,
    // then unmount). Non-fullscreen already wrote to scrollback during the run.
    if (wasFullscreen) {
      try {
        const dump = render(<TranscriptStatic />, { patchConsole: false });
        await sleep(40);
        dump.unmount();
      } catch {
        /* ignore — transcript dump is best-effort */
      }
    }
  }
}
