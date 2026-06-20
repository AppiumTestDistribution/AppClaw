import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, symbols } from '../theme.js';
import { OrbitalSpinner } from './OrbitalSpinner.js';
import type { PlanItem } from '../store.js';

function fmtDuration(ms?: number): string {
  if (ms == null) return '';
  return ms < 60000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * Live plan checklist — each sub-goal ticks green/red as it completes.
 * `live` shows a spinner on the running item; the committed snapshot does not.
 */
export function PlanChecklist({ items, live = true }: { items: PlanItem[]; live?: boolean }) {
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={COLORS.brand} bold>
        {' '}
        Plan
      </Text>
      {items.map((it, i) => {
        const done = it.status === 'done';
        const failed = it.status === 'failed';
        const running = it.status === 'running';
        const stepsStr = it.steps != null ? `${it.steps} step${it.steps === 1 ? '' : 's'}` : '';
        const durStr = it.durationMs != null ? fmtDuration(it.durationMs) : '';
        const meta =
          (done || failed) && (stepsStr || durStr)
            ? `  ${[stepsStr, durStr].filter(Boolean).join(' · ')}`
            : '';
        return (
          <Box key={i}>
            <Box width={4}>
              <Text color={COLORS.dimmed}>{String(i + 1).padStart(2)}.</Text>
            </Box>
            <Box width={3}>
              {running && live ? (
                <OrbitalSpinner />
              ) : done ? (
                <Text color={COLORS.green} bold>
                  {symbols.check}
                </Text>
              ) : failed ? (
                <Text color={COLORS.red} bold>
                  {symbols.cross}
                </Text>
              ) : (
                <Text color={COLORS.muted}>{symbols.circleEmpty}</Text>
              )}
            </Box>
            <Text
              color={failed ? COLORS.red : it.status === 'pending' ? COLORS.dimmed : undefined}
              bold={running}
            >
              {it.goal}
            </Text>
            {meta ? <Text color={COLORS.dimmed}>{meta}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
