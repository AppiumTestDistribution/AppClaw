/**
 * The runner's live dashboard.
 *
 * Layout (interactive TTY):
 *
 *   <Static>  ← persists in scrollback
 *     ✓ list is visible after login           5556   9.1s
 *     ✗ flaky thing                           5554   3.2s  ↻2
 *
 *   ╭ AppClaw Runner ─ android · 2 devices · 2 workers ─ 0:18 ╮
 *   │  ▓▓▓▓▓▓▓░░░░░░  3/5    ✓ 3   ✗ 0   ↻ 1                  │
 *   │                                                         │
 *   │  ⠙ emulator-5554   slider shows two green dots     12s  │
 *   │  ⠹ emulator-5556   Login › click login              7s  │
 *   │                                                         │
 *   │  queue  ▣▣░░  2 waiting                                 │
 *   ╰─────────────────────────────────────────────────────────╯
 *
 * Completed rows and the final summary live in <Static>; the bordered box is
 * the only region redrawn each tick. On unmount the Static content (incl. the
 * summary) remains in scrollback.
 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, Static, useStdout } from 'ink';
import { COLORS, symbols } from '../../ui/ink/theme.js';
import {
  subscribe,
  getSnapshot,
  type RunnerUIState,
  type StaticItem,
  type LaneState,
} from './store.js';

const BAR_W = 16;
const QUEUE_W = 10;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** A completed test row (committed to scrollback). */
function ResultRow({
  item,
  nameW,
}: {
  item: Extract<StaticItem, { kind: 'result' }>;
  nameW: number;
}) {
  const ok = item.status === 'passed';
  return (
    <Box>
      <Text color={ok ? COLORS.green : COLORS.red}>{ok ? symbols.check : symbols.cross} </Text>
      <Text color={ok ? COLORS.white : COLORS.red}>{pad(truncate(item.title, 48), 48)}</Text>
      <Text color={COLORS.dimmed}>
        {'  '}
        {pad(item.device, nameW)}
      </Text>
      <Text color={COLORS.label}>
        {'  '}
        {pad(fmtElapsed(item.ms), 6)}
      </Text>
      {item.retries > 0 ? (
        <Text color={COLORS.yellow}>
          {'  '}↻{item.retries}
        </Text>
      ) : null}
    </Box>
  );
}

function statusGlyph(status: string): { icon: string; color: string } {
  if (status === 'passed') return { icon: symbols.check, color: COLORS.green };
  if (status === 'failed') return { icon: symbols.cross, color: COLORS.red };
  return { icon: '⊘', color: COLORS.dimmed };
}

/** Strip the cwd prefix so files read as `tests/login.spec.ts`. */
function relFile(file?: string): string {
  if (!file) return '(no file)';
  const cwd = process.cwd();
  return file.startsWith(cwd) ? file.slice(cwd.length).replace(/^[/\\]/, '') : file;
}

/**
 * The end-of-run report, committed last: tests grouped by the spec file they
 * live in, each row showing status, device and duration. This is the scannable
 * summary — the rows that streamed during the run are interleaved with hook
 * logs, so a consolidated table lands at the bottom no matter how noisy the run.
 */
function SummaryRow({ item }: { item: Extract<StaticItem, { kind: 'summary' }> }) {
  const titleW = 42;
  const devW = Math.max(8, ...item.results.map((r) => (r.device?.name ?? '').length));

  // Group by file, preserving first-seen order.
  const order: string[] = [];
  const byFile = new Map<string, typeof item.results>();
  for (const r of item.results) {
    const key = relFile(r.file);
    if (!byFile.has(key)) {
      byFile.set(key, []);
      order.push(key);
    }
    byFile.get(key)!.push(r);
  }

  // Per-device tally for the totals line.
  const devCounts = new Map<string, number>();
  for (const r of item.results) {
    if (!r.device) continue;
    devCounts.set(r.device.name, (devCounts.get(r.device.name) ?? 0) + 1);
  }

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={COLORS.brand} bold>
        Results
      </Text>
      {order.map((file) => (
        <Box key={file} flexDirection="column" marginTop={1}>
          <Text color={COLORS.step}>
            {file}
            <Text color={COLORS.dimmed}> ({byFile.get(file)!.length})</Text>
          </Text>
          {byFile.get(file)!.map((r, i) => {
            const g = statusGlyph(r.status);
            return (
              <Box key={i} flexDirection="column">
                <Box>
                  <Text color={g.color}>
                    {'  '}
                    {g.icon}{' '}
                  </Text>
                  <Text color={r.status === 'failed' ? COLORS.red : COLORS.white}>
                    {pad(truncate(r.title, titleW), titleW)}
                  </Text>
                  <Text color={COLORS.dimmed}>
                    {'  '}
                    {pad(r.device?.name ?? '—', devW)}
                  </Text>
                  <Text color={COLORS.label}>
                    {'  '}
                    {pad(r.durationMs ? fmtElapsed(r.durationMs) : '—', 6)}
                  </Text>
                  {r.retries > 0 ? (
                    <Text color={COLORS.yellow}>
                      {'  '}↻{r.retries}
                    </Text>
                  ) : null}
                </Box>
                {r.status === 'failed' && r.error ? (
                  <Text color={COLORS.redDim}>
                    {'      '}
                    {truncate(r.error, titleW + 12)}
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ))}

      <Box marginTop={1} flexDirection="column">
        <Text color={COLORS.muted}>{'─'.repeat(58)}</Text>
        <Box gap={2}>
          <Text color={COLORS.green} bold>
            {symbols.check} {item.passed} passed
          </Text>
          {item.failed > 0 ? (
            <Text color={COLORS.red} bold>
              {symbols.cross} {item.failed} failed
            </Text>
          ) : null}
          {item.skipped > 0 ? <Text color={COLORS.dimmed}>⊘ {item.skipped} skipped</Text> : null}
          <Text color={COLORS.dimmed}>in {fmtElapsed(item.ms)}</Text>
          {devCounts.size > 0 ? (
            <Text color={COLORS.muted}>
              {symbols.dot} {[...devCounts].map(([d, n]) => `${d}: ${n}`).join('  ')}
            </Text>
          ) : null}
        </Box>
        {item.reportPath ? (
          <Text color={COLORS.brand}>
            {symbols.arrow} report <Text color={COLORS.step}>{item.reportPath}</Text>
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

/** A one-off advisory line (worker clamp, idle device …). */
function NoticeRow({ item }: { item: Extract<StaticItem, { kind: 'notice' }> }) {
  return (
    <Text color={COLORS.yellow}>
      {symbols.warning} {item.message}
    </Text>
  );
}

function StaticRow({ item, nameW }: { item: StaticItem; nameW: number }) {
  if (item.kind === 'notice') return <NoticeRow item={item} />;
  if (item.kind === 'result') return <ResultRow item={item} nameW={nameW} />;
  return <SummaryRow item={item} />;
}

/** Braille spinner frame, ticked by the parent's clock. */
function Spinner({ tick, color }: { tick: number; color: string }) {
  const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  return <Text color={color}>{FRAMES[tick % FRAMES.length]}</Text>;
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const ratio = total > 0 ? done / total : 0;
  const filled = Math.round(ratio * BAR_W);
  return (
    <Text>
      <Text color={COLORS.brand}>{'▓'.repeat(filled)}</Text>
      <Text color={COLORS.muted}>{'░'.repeat(BAR_W - filled)}</Text>
    </Text>
  );
}

function Lane({
  lane,
  now,
  nameW,
  tick,
}: {
  lane: LaneState;
  now: number;
  nameW: number;
  tick: number;
}) {
  const active = !!lane.title;
  const elapsed = active && lane.startedAt ? fmtElapsed(now - lane.startedAt) : '';
  return (
    <Box>
      {active ? (
        <Spinner tick={tick} color={COLORS.brand} />
      ) : (
        <Text color={COLORS.greenDim}>●</Text>
      )}
      <Text color={active ? COLORS.white : COLORS.dimmed}> {pad(lane.device.name, nameW)}</Text>
      <Text color={active ? COLORS.step : COLORS.dimmed}>
        {'  '}
        {active ? truncate(lane.title as string, 40) : 'idle'}
      </Text>
      {lane.retry > 0 ? <Text color={COLORS.yellow}> ↻{lane.retry}</Text> : null}
      {elapsed ? (
        <Text color={COLORS.label}>
          {'  '}
          {elapsed}
        </Text>
      ) : null}
    </Box>
  );
}

function Counts({ state }: { state: RunnerUIState }) {
  return (
    <Box gap={2}>
      <Text color={COLORS.label} bold>
        {state.finished}
        <Text color={COLORS.muted}>/{state.runnable}</Text>
      </Text>
      <Text color={COLORS.green}>
        {symbols.check} {state.passed}
      </Text>
      <Text color={state.failed > 0 ? COLORS.red : COLORS.dimmed}>
        {symbols.cross} {state.failed}
      </Text>
      {state.flaky > 0 ? <Text color={COLORS.yellow}>↻ {state.flaky}</Text> : null}
      {state.skipped > 0 ? <Text color={COLORS.dimmed}>⊘ {state.skipped}</Text> : null}
    </Box>
  );
}

function QueueRow({ waiting }: { waiting: number }) {
  const shown = Math.min(waiting, QUEUE_W);
  return (
    <Box>
      <Text color={COLORS.label}>queue </Text>
      <Text color={COLORS.step}>{'▣'.repeat(shown)}</Text>
      <Text color={COLORS.muted}>{'░'.repeat(QUEUE_W - shown)}</Text>
      <Text color={COLORS.dimmed}>
        {'  '}
        {waiting > 0 ? `${waiting} waiting` : 'queue drained'}
      </Text>
    </Box>
  );
}

/** The live, in-place dashboard box (booting → running). */
function LiveBox({ state, now, tick }: { state: RunnerUIState; now: number; tick: number }) {
  const { stdout } = useStdout();
  const width = Math.min((stdout?.columns ?? 80) - 2, 74);
  const nameW = Math.max(12, ...state.lanes.map((l) => l.device.name.length));

  if (state.phase === 'booting') {
    return (
      <Box marginTop={1}>
        <Spinner tick={tick} color={COLORS.brand} />
        <Text color={COLORS.step} bold>
          {' '}
          {state.boot}
        </Text>
      </Box>
    );
  }

  const running = state.lanes.filter((l) => l.title).length;
  const waiting = Math.max(0, state.runnable - state.started);
  const elapsed = fmtElapsed(now - state.startedAt);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.brand}
      paddingX={1}
      width={width}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={COLORS.brand} bold>
            AppClaw Runner
          </Text>
          <Text color={COLORS.muted}>{symbols.dot}</Text>
          <Text color={COLORS.label}>
            {state.platform} · {state.lanes.length} device{state.lanes.length === 1 ? '' : 's'} ·{' '}
            {state.workers} worker{state.workers === 1 ? '' : 's'}
          </Text>
        </Box>
        <Text color={COLORS.dimmed}>{elapsed}</Text>
      </Box>

      <Box marginTop={1} gap={2}>
        <ProgressBar done={state.finished} total={state.runnable} />
        <Counts state={state} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        {state.lanes.map((lane) => (
          <Lane key={lane.device.udid} lane={lane} now={now} nameW={nameW} tick={tick} />
        ))}
      </Box>

      <Box marginTop={1}>
        <QueueRow waiting={waiting} />
      </Box>

      {running === 0 && waiting === 0 ? (
        <Box marginTop={1}>
          <Text color={COLORS.dimmed}>finishing…</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function Dashboard() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const nameW = Math.max(
    8,
    ...state.staticItems.map((i) => (i.kind === 'result' ? i.device.length : 0))
  );

  // One clock drives every elapsed timer and spinner frame while the run is live.
  const [now, setNow] = useState(Date.now());
  const [tick, setTick] = useState(0);
  const live = state.phase !== 'done';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      setNow(Date.now());
      setTick((x) => x + 1);
    }, 120);
    return () => clearInterval(t);
  }, [live]);

  return (
    <Box flexDirection="column">
      <Static items={state.staticItems}>
        {(item) => <StaticRow key={item.id} item={item} nameW={nameW} />}
      </Static>
      {live ? <LiveBox state={state} now={now} tick={tick} /> : null}
    </Box>
  );
}
