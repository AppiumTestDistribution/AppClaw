import React, { useSyncExternalStore } from 'react';
import { Box, Text, Static, useStdout } from 'ink';
import { COLORS, symbols } from './theme.js';
import { subscribe, getSnapshot, type TimelineEntry, type UIState } from './store.js';
import { StepLine } from './components/StepLine.js';
import { LogLine } from './components/LogLine.js';
import { AgentBottomBar } from './components/AgentBottomBar.js';
import { ResultBox } from './components/ResultBox.js';
import { TokenSummary } from './components/TokenSummary.js';
import { FinalSummary } from './components/FinalSummary.js';
import { PlanChecklist } from './components/PlanChecklist.js';
import { OrbitalSpinner } from './components/OrbitalSpinner.js';
import { HitlPrompt } from './components/HitlPrompt.js';

const STREAM_MAX_LINES = 5;
const STREAM_WIDTH = 72;
const FOOTER_H = 4; // AgentBottomBar: marginTop + divider + goal + status

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ').filter(Boolean);
    let line = '';
    for (const w of words) {
      if (line && line.length + w.length + 1 > width) {
        out.push(line);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function GoalHeader({ goal, maxSteps }: { goal: string; maxSteps: number }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={COLORS.brand} bold>
        {' '}
        Goal
      </Text>
      <Box borderStyle="round" borderColor={COLORS.brand} paddingX={2} flexDirection="column">
        <Text bold>{goal}</Text>
        <Text color={COLORS.dimmed}>max {maxSteps} steps</Text>
      </Box>
    </Box>
  );
}

/** Compact sub-goal divider committed to the transcript between sub-goals. */
function SubGoalDivider({ index, total, goal }: { index: number; total: number; goal: string }) {
  return (
    <Box marginTop={1} marginBottom={0}>
      <Text color={COLORS.brand} bold>
        {'── '}
        {index + 1}/{total}{' '}
      </Text>
      <Text color={COLORS.white} bold>
        {goal}{' '}
      </Text>
      <Text color={COLORS.muted}>{'─'.repeat(Math.max(2, 40 - goal.length))}</Text>
    </Box>
  );
}

/** Render one committed timeline entry. */
export function renderEntry(entry: TimelineEntry): React.ReactNode {
  switch (entry.type) {
    case 'header':
      return <GoalHeader key={entry.id} goal={entry.goal} maxSteps={entry.maxSteps} />;
    case 'plan':
      return <PlanChecklist key={entry.id} items={entry.items} live={false} />;
    case 'step':
      return <StepLine key={entry.id} data={entry.data} />;
    case 'log':
      return <LogLine key={entry.id} entry={entry.entry} />;
    case 'subgoal':
      return (
        <SubGoalDivider key={entry.id} index={entry.index} total={entry.total} goal={entry.goal} />
      );
    case 'result':
      return <ResultBox key={entry.id} result={entry.result} durationMs={entry.durationMs} />;
    case 'summary':
      return <TokenSummary key={entry.id} data={entry.data} />;
    case 'journey':
      return <FinalSummary key={entry.id} data={entry.data} />;
  }
}

/** Rough rendered-height estimate per entry, for the scrolling viewport. */
function estimateHeight(e: TimelineEntry): number {
  switch (e.type) {
    case 'header':
      return 5;
    case 'plan':
      return 2 + e.items.length;
    case 'subgoal':
      return 2;
    case 'step':
      return 1 + (e.data.detail ? 1 : 0) + (e.data.tokens ? 1 : 0);
    case 'log':
      return 1 + (e.entry.detail ? 1 : 0);
    case 'result':
      return 7;
    case 'summary':
      return 6;
    case 'journey':
      return 9 + e.data.subGoals.length;
  }
}

/** Take the trailing entries that fit within `budget` rows. */
export function tailSlice(entries: TimelineEntry[], budget: number): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let h = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    h += estimateHeight(entries[i]);
    if (h > budget && out.length > 0) break;
    out.unshift(entries[i]);
  }
  return out;
}

function LiveRegion({ state, showSteps }: { state: UIState; showSteps: boolean }) {
  const { liveStep, thinking, streaming, hitl } = state;
  const streamLines = streaming.active
    ? wrap(streaming.text, STREAM_WIDTH).slice(-STREAM_MAX_LINES)
    : [];
  return (
    <Box flexDirection="column">
      {liveStep && showSteps ? <StepLine data={liveStep} /> : null}
      {thinking.active ? (
        <Box marginLeft={2}>
          <OrbitalSpinner />
          <Text color={COLORS.step} bold>
            {' '}
            {thinking.primary}
          </Text>
          {thinking.detail ? <Text color={COLORS.dimmed}> ({thinking.detail})</Text> : null}
        </Box>
      ) : null}
      {streaming.active ? (
        <Box flexDirection="column" marginLeft={2}>
          <Text color={COLORS.step}>
            {symbols.bar} {streaming.label}
          </Text>
          {streamLines.map((line, i) => (
            <Text key={i} color={COLORS.dimmed}>
              {symbols.bar} {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {hitl ? (
        <HitlPrompt
          type={hitl.type}
          question={hitl.question}
          options={hitl.options}
          onSubmit={hitl.onSubmit}
        />
      ) : null}
    </Box>
  );
}

/**
 * Live agent screen. On an interactive TTY (real `rows`) it renders fullscreen:
 * a scrolling viewport that shows the tail of the transcript above a pinned
 * footer. Without `rows` (tests/headless) it falls back to a plain top-down
 * render so every entry is captured.
 */
export function RunScreen() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 0;
  const {
    maxSteps,
    currentStep,
    ctx,
    timeline,
    tokens,
    result,
    startTime,
    showSteps,
    fullscreen,
    planGoals,
  } = state;

  const visible = visibleEntries(timeline, showSteps);
  const showFooter = !result && (maxSteps > 0 || !!ctx.currentSubGoal || !!ctx.overallGoal);
  // The live, ticking checklist shows during the run; once finished the
  // committed snapshot in the timeline takes over.
  const liveChecklist =
    planGoals.length > 0 && !result ? <PlanChecklist items={planGoals} live /> : null;

  const footer = showFooter ? (
    <AgentBottomBar
      ctx={ctx}
      currentStep={currentStep}
      maxSteps={maxSteps}
      startTime={startTime}
      tokens={tokens}
    />
  ) : null;

  // ── Fullscreen: pinned checklist (top) + scrolling viewport + footer ──
  if (fullscreen && rows > 0) {
    const footerH = showFooter ? FOOTER_H : 0;
    const checklistH = liveChecklist ? planGoals.length + 2 : 0;
    const contentH = Math.max(3, rows - footerH - checklistH);
    const slice = tailSlice(visible, contentH - 4); // reserve room for the live region
    return (
      <Box flexDirection="column" height={rows}>
        {liveChecklist}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {slice.map(renderEntry)}
          <LiveRegion state={state} showSteps={showSteps} />
        </Box>
        {footer}
      </Box>
    );
  }

  // ── Fallback: plain top-down render (headless / tests) ──
  return (
    <Box flexDirection="column">
      <Static items={visible}>{(entry) => renderEntry(entry)}</Static>
      <Box flexDirection="column">
        {liveChecklist}
        <LiveRegion state={state} showSteps={showSteps} />
        {footer}
      </Box>
    </Box>
  );
}

/**
 * Filter the transcript for display. Debug (showSteps) shows everything;
 * the default agent view collapses to the plan checklist + final summary +
 * any errors (per-step rows, result boxes, dividers and orchestrator notes are
 * hidden — the live checklist conveys progress).
 */
function visibleEntries(timeline: TimelineEntry[], showSteps: boolean): TimelineEntry[] {
  if (showSteps) return timeline;
  return timeline.filter(
    (t) =>
      t.type === 'plan' ||
      t.type === 'journey' ||
      t.type === 'header' ||
      (t.type === 'log' && t.entry.kind === 'error')
  );
}

/** Dumps the committed transcript to normal scrollback (used on exit). */
export function TranscriptStatic() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <Static items={visibleEntries(state.timeline, state.showSteps)}>
      {(entry) => renderEntry(entry)}
    </Static>
  );
}
