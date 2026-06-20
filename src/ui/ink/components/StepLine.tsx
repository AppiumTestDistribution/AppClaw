import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, symbols, getActionIcon } from '../theme.js';
import { OrbitalSpinner } from './OrbitalSpinner.js';
import { ShimmerText } from './ShimmerText.js';
import type { StepData } from '../store.js';

const VERB_WIDTH = 7;
const TARGET_WIDTH = 48;

function fmtDuration(ms?: number): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One agent step row:
 *
 *   [3/12]  ✓  tap    "search icon"                    ●  0.8s
 *              ↳  Tapped "search icon" at [432, 421]
 */
export function StepLine({ data }: { data: StepData }) {
  const { step, maxSteps, verb, actionType, target, status, detail, durationMs, tokens } = data;
  const isRunning = status === 'running';
  const isFailed = status === 'failed';
  const isDone = status === 'done';

  const maxTarget = TARGET_WIDTH;
  const displayTarget = target.length > maxTarget ? target.slice(0, maxTarget - 1) + '…' : target;

  return (
    <Box flexDirection="column">
      <Box marginLeft={2}>
        {/* step counter */}
        <Box width={8}>
          <Text color={COLORS.dimmed}>{`[${step}/${maxSteps}]`}</Text>
        </Box>

        {/* status icon */}
        <Box width={3}>
          {isRunning ? (
            <OrbitalSpinner />
          ) : isFailed ? (
            <Text color={COLORS.red} bold>
              {symbols.cross}
            </Text>
          ) : (
            <Text color={COLORS.green} bold>
              {symbols.check}
            </Text>
          )}
        </Box>

        {/* verb */}
        <Box width={VERB_WIDTH}>
          <Text color={isFailed ? COLORS.red : COLORS.step}>{verb}</Text>
        </Box>

        {/* target */}
        <Box width={TARGET_WIDTH + 1}>
          {isRunning ? (
            <ShimmerText text={displayTarget} active />
          ) : isFailed ? (
            <Text color={COLORS.red}>{displayTarget}</Text>
          ) : (
            <Text>{displayTarget}</Text>
          )}
        </Box>

        {/* action icon */}
        <Box width={3}>
          {isDone || isFailed ? (
            <Text color={COLORS.muted}>{getActionIcon(actionType)}</Text>
          ) : null}
        </Box>

        {/* duration */}
        <Box width={7} justifyContent="flex-end">
          <Text color={COLORS.dimmed}>{fmtDuration(durationMs)}</Text>
        </Box>
      </Box>

      {/* result detail */}
      {detail ? (
        <Box marginLeft={13}>
          <Text color={isFailed ? COLORS.red : COLORS.dimmed}>
            {symbols.arrowDown} {detail}
          </Text>
        </Box>
      ) : null}

      {/* per-step tokens */}
      {tokens ? (
        <Box marginLeft={13}>
          <Text color={COLORS.muted}>
            ⟠ {tokens.input + tokens.output} tokens (in {tokens.input} · out {tokens.output}
            {tokens.cached ? ` · cached ${tokens.cached}` : ''})
            {tokens.cost != null && tokens.cost > 0 ? `  $${tokens.cost.toFixed(5)}` : ''}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
