import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { COLORS, symbols } from '../theme.js';
import type { ResultData } from '../store.js';

/** Final outcome panel — success or failure. Token/cost shown separately. */
export function ResultBox({ result, durationMs }: { result: ResultData; durationMs: number }) {
  const { stdout } = useStdout();
  const W = Math.min((stdout?.columns ?? 80) - 4, 100);
  const ok = result.status === 'success';
  const color = ok ? COLORS.green : COLORS.red;
  const icon = ok ? symbols.check : symbols.cross;
  const label = ok ? 'COMPLETED' : 'FAILED';
  const durationStr =
    durationMs < 60000
      ? `${(durationMs / 1000).toFixed(1)}s`
      : `${Math.floor(durationMs / 60000)}m ${Math.round((durationMs % 60000) / 1000)}s`;

  return (
    <Box flexDirection="column" marginTop={1} width={W}>
      <Box borderStyle="round" borderColor={color} flexDirection="column" paddingX={1} width={W}>
        <Box>
          <Text bold color={color}>
            {icon} {label}
          </Text>
          <Text color={COLORS.dimmed}>
            {' '}
            · {result.steps > 0 ? `${result.steps} steps · ` : ''}
            {durationStr}
          </Text>
        </Box>
        <Text> </Text>
        <Text>{result.reason}</Text>
      </Box>
    </Box>
  );
}
