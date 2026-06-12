/**
 * Rolling run summary — compress the earliest steps of a long agent run.
 *
 * The LLM provider already injects the last ~25 raw action results into each
 * prompt as ACTION_HISTORY. For runs longer than that — or just to keep the
 * prompt smaller earlier — we compress the *older* steps into a couple of
 * bullets and surface them as RUN_SUMMARY. The recent few steps stay raw so
 * the agent can react to its most recent action precisely.
 *
 * v1: deterministic compression (no extra LLM call). Groups consecutive same-
 * tool steps and counts failures. An LLM-based compressor can replace
 * `compressRecords` later without touching the loop.
 */

import type { StepRecord } from './loop.js';

/** How many trailing raw steps to keep uncompressed. */
const LIVE_TAIL = 3;

export interface RunSummaryOptions {
  /** Refresh the compressed prefix every N steps. 0 disables summarization. */
  everyNSteps: number;
}

export class RunSummary {
  private readonly everyN: number;
  private cached?: string;
  private cachedThrough = 0;

  constructor(opts: RunSummaryOptions) {
    this.everyN = Math.max(0, opts.everyNSteps);
  }

  /**
   * Update the summary based on the run's full history.
   *
   * Compression only refreshes every `everyN` completed steps to avoid
   * re-rendering on every tick. Returns the current summary text, or
   * undefined when there isn't enough older history to be worth compressing.
   */
  update(history: StepRecord[]): string | undefined {
    if (this.everyN <= 0) return undefined;
    if (history.length <= LIVE_TAIL) return undefined;

    const compressibleCount = history.length - LIVE_TAIL;
    // Only refresh on cadence; reuse cached text in between.
    if (compressibleCount - this.cachedThrough < this.everyN && this.cached) {
      return this.cached;
    }

    const older = history.slice(0, compressibleCount);
    this.cached = compressRecords(older);
    this.cachedThrough = compressibleCount;
    return this.cached;
  }

  /** Current summary text, if any. */
  text(): string | undefined {
    return this.cached;
  }
}

/**
 * Deterministic compressor: groups consecutive same-tool actions, marks
 * failures explicitly. Output is at most ~4 bullets, ~120 chars each.
 */
export function compressRecords(records: StepRecord[]): string {
  if (records.length === 0) return '';

  type Group = { tool: string; count: number; failures: number; sample: string };
  const groups: Group[] = [];

  for (const r of records) {
    const failed = /FAILED|✗|failed/.test(r.result);
    const last = groups[groups.length - 1];
    if (last && last.tool === r.action) {
      last.count += 1;
      if (failed) last.failures += 1;
    } else {
      groups.push({
        tool: r.action,
        count: 1,
        failures: failed ? 1 : 0,
        sample: shortSample(r),
      });
    }
  }

  const lines = groups.map((g) => {
    const tag = g.failures > 0 ? ` (${g.failures} failed)` : '';
    const countLabel = g.count > 1 ? `${g.count}× ` : '';
    return `- ${countLabel}${g.tool}${tag}: ${g.sample}`;
  });

  // Cap at 4 bullets — the older grouped actions, not the live tail.
  if (lines.length > 4) {
    const dropped = lines.length - 4;
    return [...lines.slice(0, 4), `…(+${dropped} more earlier action groups)`].join('\n');
  }
  return lines.join('\n');
}

function shortSample(r: StepRecord): string {
  // Pull a short representative selector/text from the decision args.
  const args = r.decision?.args ?? {};
  const selector = String((args as Record<string, unknown>).selector ?? '');
  const text = String((args as Record<string, unknown>).text ?? '');
  const appId = String((args as Record<string, unknown>).appId ?? '');
  let sample = selector || appId || '';
  if (text) sample = sample ? `${sample} with "${text}"` : `"${text}"`;
  if (!sample) sample = '(no args)';
  if (sample.length > 60) sample = sample.slice(0, 57) + '…';
  return sample;
}
