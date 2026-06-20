import React, { useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { COLORS, symbols } from './theme.js';
import { OrbitalSpinner } from './components/OrbitalSpinner.js';
import { PlaygroundBottomBar, type PlaygroundInfo } from './components/PlaygroundBottomBar.js';
import { subscribe, getSnapshot } from './playground-store.js';

export interface PlaygroundAppProps {
  info: PlaygroundInfo;
  /** Execute one REPL line (slash command or natural instruction). */
  onCommand: (line: string) => Promise<void>;
  /** Tear down the session before exit. */
  onQuit: () => Promise<void>;
  /** Current recorded step count (read after each command). */
  getStepCount: () => number;
  /** Notify when the line count changes so the prompt counter updates. */
  refreshStepCount: () => void;
}

const QUIT = new Set(['/quit', '/exit', '/q']);

/**
 * Ink playground REPL shell. Owns raw-mode stdin via <TextInput> (no readline),
 * pins a styled prompt + status bar at the bottom, and lets command output
 * scroll above it via Ink's patchConsole.
 */
export function PlaygroundApp({
  info,
  onCommand,
  onQuit,
  refreshStepCount,
}: PlaygroundAppProps) {
  const { exit } = useApp();
  const ui = useSyncExternalStore(subscribe, getSnapshot);
  const [value, setValue] = useState('');

  async function submit(raw: string): Promise<void> {
    const line = raw.trim();
    setValue('');
    if (!line) return;
    if (ui.processing) return;

    const { pgStore } = await import('./playground-store.js');

    // Quit handling with unsaved-steps confirmation.
    if (QUIT.has(line)) {
      if (ui.stepCount > 0 && !ui.pendingQuit) {
        pgStore.setPendingQuit(true);
        return;
      }
      await onQuit();
      exit();
      return;
    }

    if (ui.pendingQuit) pgStore.setPendingQuit(false);

    pgStore.setProcessing(true);
    try {
      await onCommand(line);
    } catch (err) {
      console.log(`  ${symbols.cross} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pgStore.clearStatus();
      pgStore.setProcessing(false);
      refreshStepCount();
    }
  }

  return (
    <Box flexDirection="column">
      {ui.processing ? (
        <Box marginTop={1} paddingX={1}>
          <OrbitalSpinner />
          <Text color={COLORS.step} bold>
            {' '}
            {ui.status || 'Working…'}
          </Text>
          {ui.detail ? <Text color={COLORS.dimmed}> · {ui.detail}</Text> : null}
        </Box>
      ) : (
        <Box marginTop={1} paddingX={1}>
          <Text color={COLORS.brand} bold>
            {symbols.prompt}{' '}
          </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={submit}
            placeholder="type an action — e.g. tap on Login, type 'hello', swipe up"
          />
        </Box>
      )}

      <PlaygroundBottomBar {...info} stepCount={ui.stepCount} pendingQuit={ui.pendingQuit} />
    </Box>
  );
}
