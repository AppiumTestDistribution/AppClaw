import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.js';
import type { TokenSummaryData } from '../store.js';

const W = 64;

/** Final token / cost / model panel, committed after the result box. */
export function TokenSummary({ data }: { data: TokenSummaryData }) {
  const total = data.input + data.output;
  if (total === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2} width={W}>
      <Box>
        <Box width={9}>
          <Text color={COLORS.label}>Tokens</Text>
        </Box>
        <Text bold>{total.toLocaleString()}</Text>
        <Text color={COLORS.dimmed}>
          {' '}
          (in {data.input.toLocaleString()} · out {data.output.toLocaleString()}
          {data.cached > 0 ? ` · cached ${data.cached.toLocaleString()}` : ''})
        </Text>
      </Box>
      <Box>
        <Box width={9}>
          <Text color={COLORS.label}>Cost</Text>
        </Box>
        <Text color={COLORS.green} bold>
          ${data.cost.toFixed(4)}
        </Text>
      </Box>
      <Box>
        <Box width={9}>
          <Text color={COLORS.label}>Model</Text>
        </Box>
        <Text color={COLORS.dimmed}>{data.model}</Text>
      </Box>
    </Box>
  );
}
