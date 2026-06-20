/**
 * Ink playground launcher. Mounts the <PlaygroundApp> shell and registers a
 * minimal renderer override so the agent's ANSI spinner (used by processLine)
 * becomes status-bar text instead of fighting Ink for the cursor. All other
 * command output stays on console.log and renders above via patchConsole.
 */
import React from 'react';
import { render } from 'ink';
import { PlaygroundApp } from './PlaygroundApp.js';
import type { PlaygroundInfo } from './components/PlaygroundBottomBar.js';
import { pgStore, getSnapshot } from './playground-store.js';
import { setRenderer, type UIRenderer } from '../renderer.js';

const pgRenderer: Partial<UIRenderer> = {
  startSpinner(message, detail) {
    pgStore.setStatus(message, detail);
  },
  updateSpinner(message, detail) {
    const s = getSnapshot();
    pgStore.setStatus(message ?? s.status, detail ?? s.detail);
  },
  stopSpinner() {
    pgStore.clearStatus();
  },
  // streaming is unused in the playground — swallow to avoid ANSI writes
  startStreaming() {},
  streamChunk() {},
  stopStreaming() {},
};

export function runPlaygroundInk(opts: {
  info: PlaygroundInfo;
  onCommand: (line: string) => Promise<void>;
  onQuit: () => Promise<void>;
  getStepCount: () => number;
}): Promise<void> {
  pgStore.reset();
  pgStore.setStepCount(opts.getStepCount());
  setRenderer(pgRenderer);

  const instance = render(
    <PlaygroundApp
      info={opts.info}
      onCommand={opts.onCommand}
      onQuit={opts.onQuit}
      getStepCount={opts.getStepCount}
      refreshStepCount={() => pgStore.setStepCount(opts.getStepCount())}
    />,
    { patchConsole: true, exitOnCtrlC: true }
  );

  return instance.waitUntilExit().finally(() => setRenderer(null));
}
