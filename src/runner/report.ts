/**
 * Suite-level reporting for the runner.
 *
 * Each test's `AppClaw` already writes its own run report to `.appclaw/runs/`
 * (report: true). Here we add a suite-level index entry summarizing the whole
 * run and print a console summary. Per-run HTML reports remain viewable via
 * `appclaw --report`.
 */

import * as crypto from 'crypto';
import { writeSuiteEntry } from '../report/writer.js';
import { generateSuiteReport, type SuiteReportMeta } from './suite-report.js';
import type { SuiteResult } from './types.js';

/** A fresh suite id: `suite-20260628T101500-ab12cd`. */
export function newSuiteId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  return `suite-${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Persist the run: a suite entry in the global index (keeps the `--report`
 * viewer working) plus a standalone, current-run-only HTML report. Returns the
 * path to that HTML, or undefined if it couldn't be written (non-fatal).
 */
export async function writeSuiteReport(
  suite: SuiteResult,
  meta: SuiteReportMeta
): Promise<string | undefined> {
  const projectRoot = process.cwd();

  try {
    await writeSuiteEntry(projectRoot, {
      suiteId: meta.suiteId,
      suiteName: meta.suiteName,
      platform: meta.platform,
      startedAt: meta.startedAt,
      durationMs: suite.durationMs,
      runIds: suite.results.map((r) => r.runId).filter((id): id is string => !!id),
      passedCount: suite.passed,
      failedCount: suite.failed,
    });
  } catch {
    /* non-fatal — a missing suite index must never fail the run */
  }

  return (await generateSuiteReport(projectRoot, suite, meta)) ?? undefined;
}

/** Strip the cwd prefix so files read as `tests/login.spec.ts`. */
function relFile(file?: string): string {
  if (!file) return '(no file)';
  const cwd = process.cwd();
  return file.startsWith(cwd) ? file.slice(cwd.length).replace(/^[/\\]/, '') : file;
}

/** Human-readable summary printed after the run, grouped by spec file. */
export function printSummary(suite: SuiteResult): void {
  const { results, passed, failed, skipped, durationMs } = suite;
  // eslint-disable-next-line no-console
  const log = console.log;
  log('');
  log('── Run Summary ───────────────────────────────────────────');

  // Group by file, preserving first-seen order.
  const order: string[] = [];
  const byFile = new Map<string, typeof results>();
  for (const r of results) {
    const key = relFile(r.file);
    if (!byFile.has(key)) {
      byFile.set(key, []);
      order.push(key);
    }
    byFile.get(key)!.push(r);
  }

  for (const file of order) {
    const group = byFile.get(file)!;
    log(`  ${file} (${group.length})`);
    for (const r of group) {
      const icon = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '–';
      const dev = r.device ? ` [${r.device.name}]` : '';
      const dur = r.durationMs ? ` ${(r.durationMs / 1000).toFixed(1)}s` : '';
      const retry = r.retries > 0 ? ` ↻${r.retries}` : '';
      const tail = r.error ? ` — ${r.error}` : '';
      log(`    ${icon} ${r.title}${dev}${dur}${retry}${tail}`);
    }
  }
  log('');
  const parts = [`${passed} passed`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  log(`  ${parts.join(', ')}  (${(durationMs / 1000).toFixed(1)}s)`);
  log('');
}
