import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { COLORS } from '../theme.js';
import type { RunContext } from '../store.js';

interface Props {
  ctx: RunContext;
  currentStep: number;
  maxSteps: number;
  startTime: number;
  tokens: { input: number; output: number; cost: number };
}

const Sep = () => <Text color={COLORS.muted}>│</Text>;

function fmtElapsed(s: number): string {
  return s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Pinned status bar for agent (goal) mode — overall goal + sub-goal progress on
 * top line, live step/elapsed/model context below. Stays glued to the bottom so
 * the run is easy to follow while the transcript scrolls above.
 */
export function AgentBottomBar({ ctx, currentStep, maxSteps, startTime, tokens }: Props) {
  const { stdout } = useStdout();
  const width = Math.min(stdout?.columns ?? 80, 80);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, (now - startTime) / 1000);
  const total = tokens.input + tokens.output;
  const multi = ctx.subGoalTotal > 1;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.muted}>{'─'.repeat(width)}</Text>
      <Box paddingX={1} gap={1}>
        <Text color={COLORS.brand} bold>
          Goal
        </Text>
        <Text>{truncate(ctx.overallGoal || ctx.currentSubGoal, width - 14)}</Text>
      </Box>
      <Box paddingX={1} gap={1}>
        {multi ? (
          <>
            <Text color={COLORS.label}>sub-goal</Text>
            <Text color={COLORS.cyan} bold>
              {ctx.subGoalIndex + 1}/{ctx.subGoalTotal}
            </Text>
            <Sep />
          </>
        ) : null}
        <Text color={COLORS.label}>step</Text>
        <Text bold>
          {currentStep}
          <Text color={COLORS.label}>/{maxSteps}</Text>
        </Text>
        <Sep />
        <Text color={COLORS.label}>elapsed</Text>
        <Text bold>{fmtElapsed(elapsed)}</Text>
        {ctx.model ? (
          <>
            <Sep />
            <Text color={COLORS.dimmed}>{ctx.model}</Text>
            {ctx.mode ? <Text color={COLORS.dimmed}>· {ctx.mode}</Text> : null}
          </>
        ) : null}
        {total > 0 ? (
          <>
            <Sep />
            <Text color={COLORS.dimmed}>{total.toLocaleString()} tok</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
