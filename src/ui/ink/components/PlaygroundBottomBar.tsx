import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { COLORS, symbols } from '../theme.js';

export interface PlaygroundInfo {
  platform: string;
  app?: string;
  model: string;
  mode: string;
  transport: string;
}

interface Props extends PlaygroundInfo {
  stepCount: number;
  pendingQuit: boolean;
}

const Sep = () => <Text color={COLORS.muted}>│</Text>;

/**
 * Pinned status bar for the playground REPL — session context on one line,
 * key hints below. Inspired by the kane-cli BottomBar.
 */
export function PlaygroundBottomBar({
  platform,
  app,
  model,
  mode,
  transport,
  stepCount,
  pendingQuit,
}: Props) {
  const { stdout } = useStdout();
  const width = Math.min(stdout?.columns ?? 80, 80);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.muted}>{'─'.repeat(width)}</Text>
      <Box paddingX={1} gap={1}>
        <Text color={COLORS.green}>●</Text>
        <Text color={COLORS.label}>{platform}</Text>
        <Sep />
        <Text color={COLORS.label}>model</Text>
        <Text color={COLORS.dimmed}>{model}</Text>
        <Sep />
        <Text color={COLORS.label}>mode</Text>
        <Text color={COLORS.dimmed}>{mode}</Text>
        {app ? (
          <>
            <Sep />
            <Text color={COLORS.label}>app</Text>
            <Text color={COLORS.dimmed}>{app}</Text>
          </>
        ) : null}
        <Sep />
        <Text color={COLORS.label}>steps</Text>
        <Text color={COLORS.cyan} bold>
          {stepCount}
        </Text>
      </Box>
      <Box paddingX={1} gap={2}>
        {pendingQuit ? (
          <Text color={COLORS.yellow}>
            {symbols.warning} unsaved steps — /export to save, or /quit again to discard
          </Text>
        ) : (
          <Text color={COLORS.dimmed}>
            ↵ run · /help · /yaml · /preview · /export &lt;file&gt; · /undo · /quit
          </Text>
        )}
      </Box>
    </Box>
  );
}
