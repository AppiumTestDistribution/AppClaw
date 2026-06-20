import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, symbols } from '../theme.js';
import type { JourneySummaryData } from '../store.js';

const W = 70;

function fmtDuration(ms: number): string {
  return ms < 60000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Final journey summary — overall PASS/FAIL header, a per-sub-goal table, and
 * token/cost totals. Inspired by the kane-cli ResultBox.
 */
export function FinalSummary({ data }: { data: JourneySummaryData }) {
  const ok = data.success;
  const color = ok ? COLORS.green : COLORS.red;
  const passed = data.subGoals.filter((s) => s.status === 'completed').length;
  const failed = data.subGoals.length - passed;
  const nameW = W - 16;

  return (
    <Box flexDirection="column" marginTop={1} width={W + 4}>
      <Box borderStyle="round" borderColor={color} flexDirection="column" paddingX={1} width={W + 4}>
        {/* header */}
        <Box>
          <Text bold color={color}>
            {ok ? symbols.check : symbols.cross} {ok ? 'PASSED' : 'FAILED'}
          </Text>
          <Text color={COLORS.dimmed}>
            {' '}
            · {data.totalSteps} steps · {fmtDuration(data.durationMs)}
          </Text>
        </Box>

        <Text> </Text>
        <Text>{truncate(data.overallGoal, W)}</Text>

        {/* sub-goal table */}
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.muted}>{'─'.repeat(W)}</Text>
          <Box>
            <Text bold>Steps </Text>
            <Text color={COLORS.green}>{passed} passed</Text>
            {failed > 0 ? <Text color={COLORS.red}> · {failed} failed</Text> : null}
          </Box>
          <Text> </Text>
          {data.subGoals.map((sg, i) => {
            const sgOk = sg.status === 'completed';
            return (
              <Box key={i}>
                <Box width={3}>
                  <Text color={sgOk ? COLORS.green : COLORS.red} bold>
                    {sgOk ? symbols.check : symbols.cross}
                  </Text>
                </Box>
                <Box width={nameW}>
                  <Text color={sgOk ? undefined : COLORS.red}>{truncate(sg.goal, nameW - 1)}</Text>
                </Box>
                <Box width={8} justifyContent="flex-end">
                  <Text color={sgOk ? COLORS.green : COLORS.red} bold>
                    {sgOk ? 'pass' : 'FAIL'}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* tokens */}
        {data.tokens.input + data.tokens.output > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={COLORS.muted}>{'─'.repeat(W)}</Text>
            <Box gap={1}>
              <Text color={COLORS.label}>Tokens</Text>
              <Text bold>{(data.tokens.input + data.tokens.output).toLocaleString('en-US')}</Text>
              <Text color={COLORS.muted}>│</Text>
              <Text color={COLORS.label}>Cost</Text>
              <Text color={COLORS.green} bold>
                ${data.tokens.cost.toFixed(4)}
              </Text>
              <Text color={COLORS.muted}>│</Text>
              <Text color={COLORS.dimmed}>{data.tokens.model}</Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
