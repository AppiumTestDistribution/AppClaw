import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, symbols } from '../theme.js';
import type { LogEntry } from '../store.js';

const STYLES: Record<LogEntry['kind'], { icon: string; color: string }> = {
  info: { icon: 'ℹ', color: COLORS.cyan },
  warn: { icon: symbols.warning, color: COLORS.yellow },
  error: { icon: symbols.cross, color: COLORS.red },
  bullet: { icon: symbols.circleEmpty, color: COLORS.dimmed },
  recovery: { icon: '↻', color: COLORS.cyan },
  stuck: { icon: symbols.warning, color: COLORS.yellow },
  reasoning: { icon: symbols.bar, color: COLORS.dimmed },
  preprocessor: { icon: symbols.arrow, color: COLORS.dimmed },
};

/** A single inline log line (info / warning / bullet / reasoning …). */
export function LogLine({ entry }: { entry: LogEntry }) {
  const { icon, color } = STYLES[entry.kind];
  const dim =
    entry.kind === 'bullet' || entry.kind === 'reasoning' || entry.kind === 'preprocessor';
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Box width={2}>
          <Text color={color}>{icon}</Text>
        </Box>
        <Text color={dim ? COLORS.dimmed : undefined}>{entry.text}</Text>
      </Box>
      {entry.detail ? (
        <Box marginLeft={2}>
          <Text color={COLORS.dimmed}>{entry.detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
