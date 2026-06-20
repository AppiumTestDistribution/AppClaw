/**
 * Playground REPL store — small observable state for the Ink playground shell.
 *
 * The playground reuses all existing command output (help, tables, step
 * results) via console.log + Ink's patchConsole; this store only carries the
 * live status bar / input state that the Ink shell renders at the bottom.
 */

export interface PlaygroundUIState {
  /** A command is executing — input is hidden, spinner shown. */
  processing: boolean;
  /** Spinner label while processing (fed by the spinner renderer override). */
  status: string;
  detail?: string;
  /** Recorded step count (drives the prompt counter). */
  stepCount: number;
  /** /quit pressed with unsaved steps — awaiting confirmation. */
  pendingQuit: boolean;
}

function initial(): PlaygroundUIState {
  return { processing: false, status: '', stepCount: 0, pendingQuit: false };
}

let state: PlaygroundUIState = initial();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function set(patch: Partial<PlaygroundUIState>): void {
  state = { ...state, ...patch };
  emit();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getSnapshot(): PlaygroundUIState {
  return state;
}

export const pgStore = {
  reset(): void {
    state = initial();
    emit();
  },
  setStatus(status: string, detail?: string): void {
    set({ status, detail });
  },
  clearStatus(): void {
    set({ status: '', detail: undefined });
  },
  setProcessing(processing: boolean): void {
    set({ processing });
  },
  setStepCount(stepCount: number): void {
    set({ stepCount });
  },
  setPendingQuit(pendingQuit: boolean): void {
    set({ pendingQuit });
  },
};
