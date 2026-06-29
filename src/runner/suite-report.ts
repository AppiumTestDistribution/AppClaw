/**
 * Standalone suite report — one self-contained HTML file per runner invocation.
 *
 * Unlike the global `--report` viewer (which indexes *every* historical run),
 * this report is scoped to the CURRENT run only. It aggregates the suite's
 * tests, links each back to its on-disk manifest (steps + screenshots + video)
 * via `runId`, and renders a mobile-focused report: per-device breakdown,
 * per-file grouping, a step timeline with device-framed screenshots (click any
 * to zoom into a full-size lightbox), failure reasons, and the run environment.
 *
 * Written to `.appclaw/runs/<suiteId>/index.html`; screenshots are referenced
 * relatively (`../<runId>/steps/…`) so the folder is portable.
 */

import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { loadRunManifest } from '../report/writer.js';
import type { Platform } from '../sdk/types.js';
import type { StepArtifact } from '../report/types.js';
import type { SuiteResult, TestResult } from './types.js';

export interface SuiteReportMeta {
  suiteId: string;
  suiteName: string;
  platform: Platform;
  startedAt: string;
  devices: { name: string; platform?: Platform }[];
  workers: number;
  provider?: string;
  model?: string;
}

interface ReportTest {
  title: string;
  file: string;
  device: string;
  /** Device OS version ("Android 14" / "iOS 17.2"), from the run manifest. */
  osVersion?: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  retries: number;
  error?: string;
  runId?: string;
  steps: ReportStep[];
  /** appium-mcp server log tail captured at failure time (failed tests only). */
  appiumMcpLog?: string;
  /** Screen recording inlined as a base64 data URI (so the report is portable). */
  videoData?: string;
  /** Stable index assigned at render time; links a list row to its detail data. */
  id?: number;
}

/** A step plus its screenshot as a data URI (read straight from the manifest). */
type ReportStep = StepArtifact & { img?: string };

/* ───────────────────────── data assembly ───────────────────────── */

/** Read a file and return a base64 data URI, or undefined if absent. */
async function fileToDataUri(absPath: string, mime: string): Promise<string | undefined> {
  try {
    const buf = await fsp.readFile(absPath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Load each test's manifest (steps/screenshots/video) and shape the model. */
async function assembleTests(projectRoot: string, results: TestResult[]): Promise<ReportTest[]> {
  return Promise.all(
    results.map(async (r) => {
      const base: ReportTest = {
        title: r.title,
        file: relFile(projectRoot, r.file),
        device: r.device?.name ?? '—',
        status: r.status,
        durationMs: r.durationMs,
        retries: r.retries,
        error: r.error,
        runId: r.runId,
        steps: [],
      };
      if (!r.runId) return base;
      const manifest = await loadRunManifest(projectRoot, r.runId).catch(() => null);
      if (manifest) {
        base.osVersion = manifest.deviceVersion;
        base.appiumMcpLog = manifest.failureLogs?.appiumMcp;
        // Screenshots are base64 in the manifest, so the report stays a single
        // portable file with no external requests. Prefer the before/tap-surface
        // screenshot when present (tap steps) so the dot lands on the screen the
        // tap happened on; fall back to the after-execution screenshot otherwise.
        base.steps = (manifest.steps ?? []).map((s) => ({
          ...s,
          img: s.beforeScreenshot ?? s.screenshot,
        }));
        // Inline the recording too (base64) so the report stays one portable
        // file — plays in place, like the screenshots.
        if (manifest.videoPath) {
          base.videoData = await fileToDataUri(
            path.join(projectRoot, '.appclaw', 'runs', r.runId, manifest.videoPath),
            'video/mp4'
          );
        }
        // Manifest duration is more precise for passed tests with sub-steps.
        if (!base.durationMs && manifest.durationMs) base.durationMs = manifest.durationMs;
      }
      return base;
    })
  );
}

function relFile(projectRoot: string, file?: string): string {
  if (!file) return '(no file)';
  return file.startsWith(projectRoot) ? file.slice(projectRoot.length).replace(/^[/\\]/, '') : file;
}

/**
 * Build + write the report. Returns the absolute path to the HTML, or null if
 * generation failed (non-fatal — a missing report must never fail the run).
 */
export async function generateSuiteReport(
  projectRoot: string,
  suite: SuiteResult,
  meta: SuiteReportMeta
): Promise<string | null> {
  try {
    const tests = await assembleTests(projectRoot, suite.results);
    const html = renderReport(suite, meta, tests);
    const dir = path.join(projectRoot, '.appclaw', 'runs', meta.suiteId);
    await fsp.mkdir(dir, { recursive: true });
    const out = path.join(dir, 'index.html');
    await fsp.writeFile(out, html, 'utf-8');
    return out;
  } catch {
    return null;
  }
}

/* ───────────────────────── formatting helpers ──────────────────── */

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDur(ms: number): string {
  if (!ms) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function fmtClock(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ───────────────────────── rendering ───────────────────────────── */

function renderReport(suite: SuiteResult, meta: SuiteReportMeta, tests: ReportTest[]): string {
  // Derive counts from `tests` so a partially-populated suite object can never
  // surface as NaN/undefined in the header cards. Prefer suite's own tallies
  // when present, else fall back to what the test list tells us.
  const passed = suite.passed ?? tests.filter((t) => t.status === 'passed').length;
  const failed = suite.failed ?? tests.filter((t) => t.status === 'failed').length;
  const skipped = suite.skipped ?? tests.filter((t) => t.status === 'skipped').length;
  const total = passed + failed + skipped;
  const ran = passed + failed;
  const passRate = ran > 0 ? Math.round((passed / ran) * 100) : 100;
  const flaky = tests.filter((t) => t.status === 'passed' && t.retries > 0).length;
  const totalSteps = tests.reduce((n, t) => n + t.steps.length, 0);
  const suiteDurationMs = suite.durationMs || tests.reduce((n, t) => n + (t.durationMs || 0), 0);
  const verdict = failed > 0 ? 'FAILED' : 'PASSED';
  // Stable id per test — shared by the list rows and the embedded detail data.
  tests.forEach((t, i) => (t.id = i));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.suiteName)} · AppClaw Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${styles()}</style>
</head>
<body class="${verdict === 'FAILED' ? 'is-failed' : 'is-passed'}">
<div class="grain"></div>
<button id="theme-toggle" class="theme-toggle" onclick="toggleTheme()" aria-label="toggle light / dark theme" title="Toggle theme">☾</button>
<main id="list-view">
  ${renderHero(meta, { verdict, passRate, ran, passed, durationMs: suiteDurationMs })}
  ${renderStats({ total, passed, failed, skipped, flaky, totalSteps, durationMs: suiteDurationMs })}
  ${renderDevices(meta, tests)}
  ${renderResults(tests)}
  ${renderFooter(meta)}
</main>
<section id="detail-view" class="detail" hidden></section>
<script>window.__REPORT__=${embedJson(buildData(tests))};</script>
<script>${script()}</script>
</body>
</html>`;
}

/** JSON for an inline <script>, with `<` escaped so it can't close the tag. */
function embedJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function renderHero(
  meta: SuiteReportMeta,
  d: { verdict: string; passRate: number; ran: number; passed: number; durationMs: number }
): string {
  const { verdict, passRate, ran, passed, durationMs } = d;
  const R = 52;
  const C = 2 * Math.PI * R;
  const dash = (passRate / 100) * C;
  const platIcon = meta.platform === 'ios' ? '' : '';
  return `<header class="hero reveal">
    <div class="hero-left">
      <div class="brand"><span class="brand-mark">◐</span> AppClaw<span class="brand-sub">runner report</span></div>
      <h1 class="suite">${esc(meta.suiteName)}</h1>
      <div class="hero-meta">
        <span class="chip plat plat-${esc(meta.platform)}">${platIcon} ${esc(meta.platform)}</span>
        <span class="chip">${esc(fmtDate(meta.startedAt))}</span>
        <span class="chip">${esc(fmtClock(durationMs))} wall</span>
        <span class="chip">${meta.devices.length} device${meta.devices.length === 1 ? '' : 's'} · ${meta.workers} worker${meta.workers === 1 ? '' : 's'}</span>
      </div>
    </div>
    <div class="hero-right">
      <div class="donut" style="--dash:${dash.toFixed(1)};--circ:${C.toFixed(1)}">
        <svg viewBox="0 0 120 120">
          <circle class="donut-track" cx="60" cy="60" r="${R}"></circle>
          <circle class="donut-value" cx="60" cy="60" r="${R}"></circle>
        </svg>
        <div class="donut-center">
          <div class="rate">${passRate}<span>%</span></div>
          <div class="rate-label">pass rate</div>
        </div>
      </div>
      <div class="verdict verdict-${verdict.toLowerCase()}">
        <span class="dot"></span>${verdict}
        <span class="verdict-sub">${passed}/${ran || passed} passed</span>
      </div>
    </div>
  </header>`;
}

function renderStats(d: {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  totalSteps: number;
  durationMs: number;
}): string {
  const tiles: Array<[string, string, string]> = [
    ['tests', String(d.total), 'neutral'],
    ['passed', String(d.passed), 'pass'],
    ['failed', String(d.failed), d.failed ? 'fail' : 'muted'],
    ['flaky', String(d.flaky), d.flaky ? 'flaky' : 'muted'],
    ['skipped', String(d.skipped), d.skipped ? 'skip' : 'muted'],
    ['steps', String(d.totalSteps), 'neutral'],
    ['duration', fmtDur(d.durationMs), 'neutral'],
  ];
  return `<section class="stats reveal">
    ${tiles
      .map(
        ([label, value, tone], i) => `<div class="tile tone-${tone}" style="--i:${i}">
        <div class="tile-value">${esc(value)}</div>
        <div class="tile-label">${esc(label)}</div>
      </div>`
      )
      .join('')}
  </section>`;
}

function renderDevices(meta: SuiteReportMeta, tests: ReportTest[]): string {
  const byDevice = new Map<string, ReportTest[]>();
  for (const t of tests) {
    if (!byDevice.has(t.device)) byDevice.set(t.device, []);
    byDevice.get(t.device)!.push(t);
  }
  const cards = [...byDevice]
    .map(([name, group]) => {
      const pass = group.filter((t) => t.status === 'passed').length;
      const fail = group.filter((t) => t.status === 'failed').length;
      const ms = group.reduce((n, t) => n + t.durationMs, 0);
      const os = group.find((t) => t.osVersion)?.osVersion;
      return `<div class="device-card">
        <div class="device-frame-mini"></div>
        <div class="device-info">
          <div class="device-name">${esc(name)}${os ? ` <span class="device-os">${esc(os)}</span>` : ''}</div>
          <div class="device-stats">
            <span class="pass">${pass}✓</span>
            ${fail ? `<span class="fail">${fail}✗</span>` : ''}
            <span class="faint">${group.length} test${group.length === 1 ? '' : 's'}</span>
            <span class="faint">${fmtDur(ms)}</span>
          </div>
        </div>
      </div>`;
    })
    .join('');
  return `<section class="devices reveal">
    <h2 class="section-title">Devices <span class="count">${byDevice.size}</span></h2>
    <div class="device-grid">${cards}</div>
  </section>`;
}

function renderResults(tests: ReportTest[]): string {
  const byFile = new Map<string, ReportTest[]>();
  for (const t of tests) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file)!.push(t);
  }

  const groups = [...byFile]
    .map(([file, group]) => {
      const fail = group.filter((t) => t.status === 'failed').length;
      const rows = group.map((t) => renderTest(t)).join('');
      return `<div class="file-group">
        <div class="file-head">
          <span class="file-icon">›</span>
          <span class="file-path">${esc(file)}</span>
          <span class="file-badge ${fail ? 'has-fail' : 'all-pass'}">${
            fail ? `${fail} failed` : 'all passed'
          }</span>
          <span class="file-count">${group.length}</span>
        </div>
        ${rows}
      </div>`;
    })
    .join('');

  return `<section class="results reveal">
    <div class="results-head">
      <h2 class="section-title">Results</h2>
      <div class="controls">
        <input id="search" class="search" type="search" placeholder="filter tests…" autocomplete="off">
        <div class="filters" role="tablist">
          <button class="filter active" data-filter="all">All</button>
          <button class="filter" data-filter="failed">Failed</button>
          <button class="filter" data-filter="passed">Passed</button>
          <button class="filter" data-filter="flaky">Flaky</button>
        </div>
      </div>
    </div>
    <div id="groups">${groups}</div>
    <div id="empty" class="empty" hidden>No tests match.</div>
  </section>`;
}

/** A clickable list row — opens the per-test detail view (Step Inspector). */
function renderTest(t: ReportTest): string {
  const flaky = t.status === 'passed' && t.retries > 0;
  const stepN = t.steps.length;
  const glyph = t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '⊘';
  return `<button class="test status-${t.status}" data-idx="${t.id}" data-status="${t.status}" data-flaky="${flaky}" data-title="${esc(t.title.toLowerCase())}" onclick="openTest(${t.id})">
    <span class="status-glyph s-${t.status}">${glyph}</span>
    <span class="test-title">${esc(t.title)}</span>
    <span class="test-tags">
      ${t.retries > 0 ? `<span class="tag tag-flaky">↻ ${t.retries}</span>` : ''}
      <span class="tag tag-device">${esc(t.device)}</span>
      ${stepN ? `<span class="tag tag-steps">${stepN} step${stepN === 1 ? '' : 's'}</span>` : ''}
      <span class="tag tag-time">${esc(fmtDur(t.durationMs))}</span>
    </span>
    <span class="chevron">›</span>
  </button>`;
}

/**
 * The instruction as the user wrote it in their test — that's what belongs in
 * the step label + the inspector's "Instruction" field. The engine's result
 * `message` ("Tapped …") is shown separately in the inspector's Message row.
 */
function stepDescription(s: StepArtifact): string {
  return s.verbatim || s.target || s.message || s.kind;
}

/* ── client data model (embedded as JSON, rendered by the detail SPA) ── */

interface ClientStep {
  n: number;
  kind: string;
  desc: string;
  status: string;
  durationMs: number;
  message?: string;
  phase?: string;
  img?: string;
  /** Ms from run start to this step — used to sync the step with the recording. */
  offsetMs?: number;
  /**
   * Raw tap point in device pixels, plus the reference frame to scale against.
   * `w`/`h` come from deviceScreenSize/screenshotSize when known; otherwise the
   * client falls back to the screenshot's natural pixel size (Android tap coords
   * already live in the screenshot's pixel space).
   */
  tap?: { x: number; y: number; w?: number; h?: number };
}
interface ClientTest {
  id: number;
  title: string;
  file: string;
  device: string;
  os?: string;
  status: string;
  durationMs: number;
  retries: number;
  error?: string;
  video?: string;
  /** appium-mcp server log tail (failed tests only). */
  mcpLog?: string;
  steps: ClientStep[];
}

/** Everything the detail view needs, keyed by test id. */
function buildData(tests: ReportTest[]): ClientTest[] {
  return tests.map((t) => ({
    id: t.id ?? 0,
    title: t.title,
    file: t.file,
    device: t.device,
    os: t.osVersion,
    status: t.status,
    durationMs: t.durationMs,
    retries: t.retries,
    error: t.error,
    video: t.videoData,
    mcpLog: t.appiumMcpLog,
    steps: t.steps.map((s, i) => ({
      n: i + 1,
      kind: s.kind,
      desc: stepDescription(s),
      status: s.status,
      durationMs: s.durationMs,
      message: s.message,
      phase: s.phase,
      img: s.img,
      offsetMs: s.videoOffsetMs,
      tap: s.tapCoordinates
        ? {
            x: s.tapCoordinates.x,
            y: s.tapCoordinates.y,
            w: s.deviceScreenSize?.width ?? s.screenshotSize?.width,
            h: s.deviceScreenSize?.height ?? s.screenshotSize?.height,
          }
        : undefined,
    })),
  }));
}

function renderFooter(meta: SuiteReportMeta): string {
  const env = [meta.provider, meta.model].filter(Boolean).join(' · ');
  return `<footer class="footer reveal">
    <div class="footer-left">
      Generated by <strong>AppClaw</strong> · suite <code>${esc(meta.suiteId)}</code>
    </div>
    <div class="footer-right">${env ? esc(env) : 'mobile agentic test run'}</div>
  </footer>`;
}

/* ───────────────────────── styles ──────────────────────────────── */

function styles(): string {
  return `
:root{
  /* matches the AppClaw site (landing/) — deep-ink dark, bright cyan accent */
  --bg:#0b0e13; --panel:#161a22; --panel-2:#1b2029; --line:#272d37;
  --ink:#e6eaf1; --muted:#919aab; --faint:#5b6473;
  --brand:#19d4ec; --brand-soft:rgba(25,212,236,.14); --brand-rgb:25,212,236;
  --pass:#3ddc97; --fail:#f0596a; --skip:#6b7280; --flaky:#f0b429;
  --r:16px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:
    radial-gradient(1100px 520px at 82% -8%, rgba(25,212,236,.10), transparent 60%),
    radial-gradient(900px 600px at -5% 0%, rgba(99,102,241,.07), transparent 55%),
    var(--bg);
  color:var(--ink);
  font-family:"Inter",ui-sans-serif,system-ui,-apple-system,sans-serif;
  font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;
  min-height:100vh;
}
body.is-failed{--brand:var(--fail);--brand-soft:rgba(240,89,106,.14);--brand-rgb:240,89,106}
.grain{position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.035;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
main{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:40px 28px 80px}
code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.85em}

/* reveal */
.reveal{opacity:0;transform:translateY(14px);animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
.stats{animation-delay:.06s}.devices{animation-delay:.12s}.results{animation-delay:.18s}.footer{animation-delay:.24s}
@keyframes rise{to{opacity:1;transform:none}}

/* light theme — flips the variable palette + a few dark-only spots */
body.light{
  --bg:#f3f6f8; --panel:#ffffff; --panel-2:#eef2f6; --line:#dce2ea;
  --ink:#15202c; --muted:#5c6675; --faint:#97a1ae;
  --brand:#0a97ad; --brand-soft:rgba(10,151,173,.12); --brand-rgb:10,151,173;
  --pass:#13a06a; --fail:#e0485f; --skip:#8a909c; --flaky:#c08400;
  background:radial-gradient(1100px 520px at 82% -8%, rgba(10,151,173,.07), transparent 60%),#f3f6f8;
  color:var(--ink);
}
body.light.is-failed{--brand:#e0485f;--brand-soft:rgba(224,72,95,.1);--brand-rgb:224,72,95}
body.light .grain{opacity:.015}
body.light .suite{background:linear-gradient(180deg,#13161d,#454c5a);-webkit-background-clip:text;background-clip:text}
body.light .donut-track{stroke:rgba(0,0,0,.08)}
body.light .hero{box-shadow:0 24px 60px -42px rgba(20,30,60,.3)}
body.light .chip{background:rgba(0,0,0,.02)}

/* theme toggle */
.theme-toggle{position:fixed;top:18px;right:18px;z-index:40;width:40px;height:40px;border-radius:11px;
  border:1px solid var(--line);background:var(--panel);color:var(--ink);font-size:17px;cursor:pointer;
  display:grid;place-items:center;transition:.15s;box-shadow:0 6px 18px -10px rgba(0,0,0,.5)}
.theme-toggle:hover{border-color:var(--brand);color:var(--brand)}

/* hero */
.hero{display:flex;justify-content:space-between;gap:32px;align-items:flex-start;
  padding:30px 30px;border:1px solid var(--line);border-radius:24px;
  background:linear-gradient(160deg,var(--panel-2),var(--panel));
  box-shadow:0 30px 80px -40px rgba(0,0,0,.8);position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:
  linear-gradient(90deg,var(--brand),transparent 40%);opacity:.08}
.brand{font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.18em;
  text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:8px}
.brand-mark{color:var(--brand);font-size:15px}
.brand-sub{color:var(--faint)}
.suite{font-family:"Plus Jakarta Sans",sans-serif;font-weight:800;
  font-size:clamp(30px,5vw,52px);line-height:1.02;letter-spacing:-.02em;margin:14px 0 16px;
  background:linear-gradient(180deg,#fff,#c8cbd6);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero-meta{display:flex;flex-wrap:wrap;gap:8px}
.chip{font-family:"JetBrains Mono",monospace;font-size:12px;padding:5px 11px;border-radius:999px;
  border:1px solid var(--line);background:rgba(255,255,255,.02);color:var(--muted)}
.chip.plat{text-transform:uppercase;letter-spacing:.06em;color:var(--ink);border-color:var(--brand);
  background:var(--brand-soft)}
.hero-right{display:flex;flex-direction:column;align-items:center;gap:16px;flex-shrink:0}
.donut{position:relative;width:128px;height:128px}
.donut svg{transform:rotate(-90deg);width:128px;height:128px}
.donut circle{fill:none;stroke-width:11;stroke-linecap:round}
.donut-track{stroke:rgba(255,255,255,.06)}
.donut-value{stroke:var(--pass);stroke-dasharray:var(--circ);stroke-dashoffset:var(--circ);
  animation:draw 1.1s cubic-bezier(.3,.8,.3,1) .25s forwards}
body.is-failed .donut-value{stroke:var(--flaky)}
@keyframes draw{to{stroke-dashoffset:calc(var(--circ) - var(--dash))}}
.donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.rate{font-family:"Plus Jakarta Sans",sans-serif;font-weight:800;font-size:30px;line-height:1}
.rate span{font-size:14px;color:var(--muted)}
.rate-label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-top:2px}
.verdict{display:flex;align-items:center;gap:9px;font-family:"Plus Jakarta Sans",sans-serif;
  font-weight:800;font-size:18px;letter-spacing:.04em;padding:8px 16px;border-radius:12px;border:1px solid var(--line)}
.verdict .dot{width:9px;height:9px;border-radius:50%}
.verdict-sub{font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:500;color:var(--muted);letter-spacing:0}
.verdict-passed{color:var(--pass)}.verdict-passed .dot{background:var(--pass);box-shadow:0 0 14px var(--pass)}
.verdict-failed{color:var(--fail)}.verdict-failed .dot{background:var(--fail);box-shadow:0 0 14px var(--fail)}

/* stats */
.stats{display:grid;grid-template-columns:repeat(7,1fr);gap:12px;margin-top:18px}
.tile{border:1px solid var(--line);border-radius:var(--r);padding:18px 16px;background:var(--panel);
  position:relative;overflow:hidden}
.tile::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--faint);opacity:.6}
.tile-value{font-family:"Plus Jakarta Sans",sans-serif;font-weight:800;font-size:30px;line-height:1;letter-spacing:-.01em}
.tile-label{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-top:8px}
.tone-pass .tile-value{color:var(--pass)}.tone-pass::after{background:var(--pass)}
.tone-fail .tile-value{color:var(--fail)}.tone-fail::after{background:var(--fail)}
.tone-flaky .tile-value{color:var(--flaky)}.tone-flaky::after{background:var(--flaky)}
.tone-skip .tile-value{color:var(--skip)}.tone-skip::after{background:var(--skip)}
.tone-neutral::after{background:var(--brand)}
.tone-muted{opacity:.55}

/* section */
.section-title{font-family:"Plus Jakarta Sans",sans-serif;font-weight:700;font-size:20px;
  margin:0 0 16px;display:flex;align-items:center;gap:10px}
.section-title .count,.file-count{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--muted);
  border:1px solid var(--line);border-radius:999px;padding:2px 9px}
.devices{margin-top:36px}
.device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.device-card{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:14px;
  padding:12px 14px;background:var(--panel)}
.device-frame-mini{width:26px;height:44px;border-radius:6px;border:2px solid var(--faint);flex-shrink:0;position:relative;
  background:linear-gradient(160deg,#222838,#11141c)}
.device-frame-mini::after{content:"";position:absolute;left:50%;top:4px;transform:translateX(-50%);width:8px;height:2px;border-radius:2px;background:var(--faint)}
.device-name{font-family:"JetBrains Mono",monospace;font-size:13px;font-weight:600}
.device-os{color:var(--muted);font-weight:500;font-size:11px;margin-left:4px}
.device-stats{display:flex;gap:10px;font-size:12px;margin-top:3px}
.device-stats .pass{color:var(--pass)}.device-stats .fail{color:var(--fail)}.faint{color:var(--faint)}

/* results */
.results{margin-top:40px}
.results-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.results-head .section-title{margin:0}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.search{font-family:"JetBrains Mono",monospace;font-size:13px;background:var(--panel);border:1px solid var(--line);
  color:var(--ink);padding:8px 13px;border-radius:10px;width:190px;outline:none}
.search:focus{border-color:var(--brand)}
.filters{display:flex;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:3px}
.filter{font-family:"Inter",sans-serif;font-size:13px;font-weight:500;color:var(--muted);background:none;
  border:none;padding:6px 13px;border-radius:7px;cursor:pointer;transition:.15s}
.filter:hover{color:var(--ink)}
.filter.active{background:var(--brand);color:#04222a;font-weight:600}

.file-group{margin-bottom:20px}
.file-head{display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid var(--line);margin-bottom:8px}
.file-icon{color:var(--brand)}
.file-path{font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--ink);font-weight:500}
.file-badge{font-size:11px;padding:2px 9px;border-radius:999px;font-weight:600}
.file-badge.all-pass{color:var(--pass);background:rgba(61,220,151,.1)}
.file-badge.has-fail{color:var(--fail);background:rgba(255,107,129,.1)}
.file-count{margin-left:auto}

.test{width:100%;display:flex;align-items:center;gap:13px;padding:14px 16px;text-align:left;
  border:1px solid var(--line);border-radius:13px;background:var(--panel);margin-bottom:8px;cursor:pointer;
  color:var(--ink);font-family:inherit;font-size:14.5px;transition:border-color .2s,transform .12s,background .2s}
.test.status-failed{border-color:rgba(255,107,129,.35)}
.test:hover{border-color:var(--brand);background:var(--panel-2);transform:translateX(2px)}
.status-glyph{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;font-size:12px;flex-shrink:0;font-weight:700}
.s-passed{background:rgba(61,220,151,.16);color:var(--pass)}
.s-failed{background:rgba(255,107,129,.16);color:var(--fail)}
.s-skipped{background:rgba(107,114,128,.16);color:var(--skip)}
.test-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.test-tags{display:flex;gap:6px;align-items:center;flex-shrink:0}
.tag{font-family:"JetBrains Mono",monospace;font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.tag-device{color:var(--ink)}
.tag-flaky{color:var(--flaky);border-color:rgba(240,180,41,.4)}
.tag-time{color:var(--brand);border-color:rgba(var(--brand-rgb),.3)}
.chevron{color:var(--faint);font-size:20px;transition:transform .15s,color .15s}
.test:hover .chevron{color:var(--brand);transform:translateX(3px)}

.error-box{border:1px solid rgba(255,107,129,.3);border-radius:10px;background:rgba(255,107,129,.06);padding:12px 14px;margin:8px 0 14px}
.error-label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--fail);font-weight:600;margin-bottom:6px}
.error-msg{font-family:"JetBrains Mono",monospace;font-size:12.5px;color:#ffd2d9;margin:0;white-space:pre-wrap;word-break:break-word}
.video-row{margin:6px 0 14px}
.video-link{font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--brand);text-decoration:none;border:1px solid rgba(var(--brand-rgb),.3);padding:6px 12px;border-radius:8px}
.video-link:hover{background:var(--brand-soft)}
.no-steps,.no-shot{color:var(--faint);font-size:13px;font-style:italic}

/* shared phone frame */
.phone{display:block;padding:6px;border-radius:18px;background:linear-gradient(160deg,#262d3e,#0f121a);
  border:1px solid #313a4f;box-shadow:0 14px 30px -16px rgba(0,0,0,.9)}
.phone-screen{position:relative;display:block;border-radius:13px;overflow:hidden;background:#000;aspect-ratio:9/19.5}
.phone-screen img{width:100%;height:100%;object-fit:cover;display:block}
.no-shot{display:grid;place-items:center;height:100%;color:var(--faint)}
.tap{position:absolute;width:26px;height:26px;border-radius:50%;transform:translate(-50%,-50%);
  border:2px solid var(--brand);background:rgba(var(--brand-rgb),.25);box-shadow:0 0 0 0 rgba(var(--brand-rgb),.5);
  animation:tap 1.8s ease-out infinite;pointer-events:none}
@keyframes tap{0%{box-shadow:0 0 0 0 rgba(var(--brand-rgb),.5)}70%{box-shadow:0 0 0 16px rgba(var(--brand-rgb),0)}100%{box-shadow:0 0 0 0 rgba(var(--brand-rgb),0)}}
.step-kind{font-family:"JetBrains Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:.05em;
  padding:2px 7px;border-radius:5px;background:var(--panel-2);border:1px solid var(--line);color:var(--muted)}

.st-passed{color:var(--pass)}.st-failed{color:var(--fail)}.st-skipped{color:var(--skip)}

/* ── detail view (per-test Step Inspector) ── */
.detail{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:28px 28px 80px;
  animation:slidein .3s cubic-bezier(.2,.7,.2,1)}
.detail[hidden]{display:none}
@keyframes slidein{from{opacity:0;transform:translateX(18px)}}
.dt-top{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-bottom:8px}
.dt-back{font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--muted);background:var(--panel);
  border:1px solid var(--line);border-radius:9px;padding:8px 14px;cursor:pointer;transition:.15s}
.dt-back:hover{color:var(--ink);border-color:var(--brand)}
.dt-title{font-family:"Plus Jakarta Sans",sans-serif;font-weight:800;font-size:clamp(22px,3vw,32px);
  letter-spacing:-.01em;margin:0;flex:1;min-width:200px}
.dt-verdict{font-family:"Plus Jakarta Sans",sans-serif;font-weight:800;letter-spacing:.04em;font-size:15px;
  padding:6px 14px;border-radius:10px;border:1px solid var(--line)}
.dt-verdict.v-passed{color:var(--pass);border-color:rgba(61,220,151,.4)}
.dt-verdict.v-failed{color:var(--fail);border-color:rgba(255,107,129,.4)}
.dt-verdict.v-skipped{color:var(--skip)}
.dt-meta{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 18px}
.dt-rec{color:var(--brand);cursor:pointer;font-family:inherit;border-color:rgba(var(--brand-rgb),.35)!important}
.dt-rec:hover{background:var(--brand-soft)}
.dt-rec.on{background:var(--brand);color:#04222a;border-color:var(--brand)!important}
.dt-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;background:#000}
.dt-logs{margin-top:20px}
.dt-logs-head{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:10px}
.logblk{border:1px solid var(--line);border-radius:12px;background:var(--panel);margin-bottom:10px;overflow:hidden}
.logblk>summary{cursor:pointer;padding:11px 14px;font-size:13px;font-weight:600;list-style:none;user-select:none}
.logblk>summary::-webkit-details-marker{display:none}
.logblk>summary::before{content:'▸';display:inline-block;margin-right:8px;color:var(--faint);transition:transform .15s}
.logblk[open]>summary::before{transform:rotate(90deg)}
.logsub{font-weight:400;color:var(--faint);font-size:11px}
.logpre{margin:0;padding:14px;border-top:1px solid var(--line);background:var(--bg);font-family:"JetBrains Mono",monospace;font-size:12px;line-height:1.55;color:var(--muted);white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto}
/* The author display:block above beats the UA [hidden]{display:none}, so the
   video would cover the screenshot by default. Restore hidden-means-hidden. */
.dt-video[hidden]{display:none}

.dt-grid{display:grid;grid-template-columns:300px 1fr 320px;gap:20px;align-items:start}
.dt-panel{border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}
.dt-steps-head,.dt-insp-head{font-family:"JetBrains Mono",monospace;font-size:11px;text-transform:uppercase;
  letter-spacing:.12em;color:var(--muted);padding:14px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
.dt-steps{padding:6px;max-height:74vh;overflow:auto}
.dt-step{display:flex;align-items:center;gap:11px;width:100%;text-align:left;padding:11px 12px;border:1px solid transparent;
  border-radius:10px;background:none;color:var(--ink);cursor:pointer;font-family:inherit;font-size:13.5px;transition:.12s}
.dt-step:hover{background:var(--panel-2)}
.dt-step.active{background:rgba(var(--brand-rgb),.1);border-color:rgba(var(--brand-rgb),.4)}
.dt-step-n{width:24px;height:24px;border-radius:7px;flex-shrink:0;display:grid;place-items:center;font-size:11px;font-weight:700;
  font-family:"JetBrains Mono",monospace;background:var(--panel-2);border:1px solid var(--line);color:var(--muted)}
.dt-step.s-passed .dt-step-n{color:var(--pass);border-color:rgba(61,220,151,.4)}
.dt-step.s-failed .dt-step-n{color:var(--fail);border-color:rgba(255,107,129,.5)}
.dt-step-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dt-step-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dt-step-kind{font-family:"JetBrains Mono",monospace;font-size:10px;text-transform:uppercase;color:var(--faint);margin-top:2px}
.dt-step-time{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--faint);flex-shrink:0}

.dt-stage{display:flex;justify-content:center;padding:8px}
.phone.big{padding:9px;border-radius:30px}
.phone.big .phone-screen{border-radius:22px;height:min(72vh,660px);aspect-ratio:9/19.5}
.phone.big .phone-screen img{object-fit:contain}

.dt-insp{padding:6px 4px}
.insp-row{padding:13px 16px;border-bottom:1px solid var(--line)}
.insp-row:last-child{border-bottom:none}
.insp-label{font-family:"JetBrains Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--faint);margin-bottom:6px}
.insp-val{font-size:14px;color:var(--ink);word-break:break-word;line-height:1.45}
.insp-val.mono{font-family:"JetBrains Mono",monospace;font-size:13px}
.insp-pill{display:inline-block;font-family:"JetBrains Mono",monospace;font-size:11px;text-transform:uppercase;letter-spacing:.06em;
  padding:3px 10px;border-radius:6px;border:1px solid var(--line)}
.insp-pill.s-passed{color:var(--pass);border-color:rgba(61,220,151,.4)}
.insp-pill.s-failed{color:var(--fail);border-color:rgba(255,107,129,.4)}
.dt-noshot{display:grid;place-items:center;height:100%;color:var(--faint);font-style:italic}
@media(max-width:960px){.dt-grid{grid-template-columns:1fr}.phone.big .phone-screen{height:auto;max-height:70vh}}

.empty{text-align:center;color:var(--faint);padding:50px;font-style:italic}

/* footer */
.footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);display:flex;
  justify-content:space-between;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
.footer code{color:var(--faint)}
.footer strong{color:var(--brand);font-weight:600}

@media(max-width:780px){
  .stats{grid-template-columns:repeat(3,1fr)}
  .hero{flex-direction:column}
  .hero-right{flex-direction:row;align-self:stretch;justify-content:space-between}
}`;
}

/* ───────────────────────── client script ───────────────────────── */

function script(): string {
  return `
var DATA=window.__REPORT__||[];
var cur=null, curStep=0, videoMode=false;

// ── theme (persisted) ──
function applyTheme(t){
  document.body.classList.toggle('light',t==='light');
  var b=document.getElementById('theme-toggle'); if(b)b.textContent=t==='light'?'☀':'☾';
  try{localStorage.setItem('appclaw-report-theme',t);}catch(e){}
}
function toggleTheme(){applyTheme(document.body.classList.contains('light')?'dark':'light');}
(function(){var s;try{s=localStorage.getItem('appclaw-report-theme');}catch(e){} if(s)applyTheme(s);})();
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmt(ms){if(!ms)return'0s';if(ms<1000)return ms+'ms';var s=ms/1000;return s<60?s.toFixed(1)+'s':Math.floor(s/60)+'m '+Math.round(s%60)+'s';}
function glyph(s){return s==='passed'?'✓':s==='failed'?'✗':'⊘';}

// ── list: filter + search ──
(function(){
  var filter='all', q='';
  var empty=document.getElementById('empty');
  function apply(){
    var any=false;
    document.querySelectorAll('.test').forEach(function(t){
      var s=t.dataset.status, fl=t.dataset.flaky==='true', title=t.dataset.title||'';
      var mf=filter==='all'||(filter==='flaky'?fl:s===filter), mq=!q||title.indexOf(q)>-1, show=mf&&mq;
      t.style.display=show?'':'none'; if(show)any=true;
    });
    document.querySelectorAll('.file-group').forEach(function(g){
      var vis=[].some.call(g.querySelectorAll('.test'),function(t){return t.style.display!=='none';});
      g.style.display=vis?'':'none';
    });
    empty.hidden=any;
  }
  document.querySelectorAll('.filter').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.filter').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); filter=b.dataset.filter; apply();
    });
  });
  var s=document.getElementById('search');
  s.addEventListener('input',function(){q=s.value.trim().toLowerCase();apply();});
})();

// ── detail view (Step Inspector) ──
function showDetail(id,push){
  var t=DATA[id]; if(!t)return;
  cur=id; curStep=0; renderDetail(t);
  document.getElementById('list-view').hidden=true;
  document.getElementById('detail-view').hidden=false;
  window.scrollTo(0,0);
  if(push&&location.hash!=='#test-'+id) history.pushState(null,'','#test-'+id);
}
function openTest(id){ showDetail(id,true); }
function back(){
  cur=null;
  document.getElementById('detail-view').hidden=true;
  document.getElementById('list-view').hidden=false;
  if(location.hash) history.pushState(null,'','#');
}
function renderDetail(t){
  videoMode=false;
  var meta='<span class="chip">'+esc(t.device)+(t.os?' · '+esc(t.os):'')+'</span>'+
    '<span class="chip">'+fmt(t.durationMs)+'</span>'+
    '<span class="chip">'+esc(t.file)+'</span>'+
    (t.retries>0?'<span class="chip" style="color:var(--flaky)">↻ '+t.retries+'</span>':'')+
    (t.video?'<button class="chip dt-rec" id="dt-rec-btn" onclick="toggleVideo()">▶ recording</button>':'');
  var err=t.error?'<div class="error-box"><div class="error-label">Failure</div><pre class="error-msg">'+esc(t.error)+'</pre></div>':'';
  var steps=t.steps.length
    ? t.steps.map(function(s,i){return '<button class="dt-step s-'+s.status+'" data-i="'+i+'" onclick="selectStep('+i+')">'+
        '<span class="dt-step-n">'+s.n+'</span>'+
        '<span class="dt-step-main"><span class="dt-step-desc">'+esc(s.desc)+'</span><span class="dt-step-kind">'+esc(s.kind)+'</span></span>'+
        '<span class="dt-step-time">'+fmt(s.durationMs)+'</span></button>';}).join('')
    : '<div class="dt-noshot" style="padding:28px">No captured steps</div>';
  document.getElementById('detail-view').innerHTML=
    '<div class="dt-top">'+
      '<button class="dt-back" onclick="back()">← all tests</button>'+
      '<span class="status-glyph s-'+t.status+'">'+glyph(t.status)+'</span>'+
      '<h2 class="dt-title">'+esc(t.title)+'</h2>'+
      '<span class="dt-verdict v-'+t.status+'">'+t.status+'</span>'+
    '</div>'+
    '<div class="dt-meta">'+meta+'</div>'+err+
    '<div class="dt-grid">'+
      '<div class="dt-panel"><div class="dt-steps-head"><span>Steps</span><span>'+t.steps.length+'</span></div><div class="dt-steps">'+steps+'</div></div>'+
      '<div class="dt-stage"><div class="phone big"><div class="phone-screen">'+
        '<img id="dt-img" alt=""><span id="dt-tap" class="tap" hidden></span>'+
        (t.video?'<video id="dt-video" class="dt-video" playsinline controls preload="metadata" hidden></video>':'')+
      '</div></div></div>'+
      '<div class="dt-panel"><div class="dt-insp-head"><span>Inspector</span></div><div class="dt-insp" id="dt-insp"></div></div>'+
    '</div>'+
    renderLogs(t);
  if(t.steps.length) selectStep(0);
}
// AppClaw trace, reconstructed from the recorded steps — what AppClaw did, in
// order, with the failing step marked. Paired with the appium-mcp server log so
// a failure shows both sides at once.
function appclawTrace(t){
  var lines=t.steps.map(function(s){
    var mark=s.status==='failed'?'✗':(s.status==='passed'?'✓':'•');
    var msg=s.message?(' — '+s.message):'';
    return mark+' #'+s.n+' '+s.kind+': '+s.desc+msg;
  });
  if(t.error) lines.push('','✗ '+t.error);
  return lines.join('\\n');
}
// Logs are most useful on failure; show the panel for failed tests, or whenever
// a server log was captured. Collapsed by default so passing runs stay clean.
function renderLogs(t){
  var show = t.status==='failed' || !!t.mcpLog;
  if(!show) return '';
  var trace=appclawTrace(t);
  var blocks='<details class="logblk" open><summary>AppClaw log</summary><pre class="logpre">'+esc(trace)+'</pre></details>';
  if(t.mcpLog) blocks+='<details class="logblk"><summary>appium-mcp server log <span class="logsub">(shared across workers)</span></summary><pre class="logpre">'+esc(t.mcpLog)+'</pre></details>';
  return '<section class="dt-logs"><div class="dt-logs-head">Logs</div>'+blocks+'</section>';
}
function placeTap(t){
  var img=document.getElementById('dt-img'), tap=document.getElementById('dt-tap'), scr=img.parentElement;
  var w=t.w||img.naturalWidth, h=t.h||img.naturalHeight;
  if(!w||!h){tap.hidden=true;return;}
  // Match the screen box to the screenshot's aspect so the % maps 1:1 (no
  // letterbox offset from object-fit:contain), then place the pulse dot.
  scr.style.aspectRatio=(img.naturalWidth||w)+'/'+(img.naturalHeight||h);
  tap.style.left=(t.x/w*100)+'%'; tap.style.top=(t.y/h*100)+'%'; tap.hidden=false;
}
function renderInspector(s){
  var rows=[['Instruction',esc(s.desc),'']];
  rows.push(['Status','<span class="insp-pill s-'+s.status+'">'+s.status+'</span>','raw']);
  rows.push(['Action',esc(s.kind),'mono']);
  if(s.phase)rows.push(['Phase',esc(s.phase),'mono']);
  rows.push(['Duration',fmt(s.durationMs),'mono']);
  if(s.message)rows.push(['Message',esc(s.message),'']);
  if(s.tap)rows.push(['Tap point','['+s.tap.x+', '+s.tap.y+']','mono']);
  document.getElementById('dt-insp').innerHTML=rows.map(function(r){
    var body=r[2]==='raw'?r[1]:'<div class="insp-val'+(r[2]==='mono'?' mono':'')+'">'+r[1]+'</div>';
    return '<div class="insp-row"><div class="insp-label">'+r[0]+'</div>'+body+'</div>';
  }).join('');
}
function highlightStep(i){
  document.querySelectorAll('.dt-step').forEach(function(b){b.classList.toggle('active',+b.dataset.i===i);});
  var act=document.querySelector('.dt-step[data-i="'+i+'"]'); if(act)act.scrollIntoView({block:'nearest'});
}
// The recording is usually much SHORTER than the wall-clock run (e.g. a 7.6s
// test captured as a ~2s clip), so step offsetMs (wall-clock from run start)
// can't index the video directly. Map proportionally: video fraction ↔ run
// fraction, using the test's total durationMs as the wall-clock span.
function videoTimeToStep(t,cur,dur){
  if(!dur||!isFinite(dur)||!t.durationMs)return curStep;
  var wall=(cur/dur)*t.durationMs, idx=0;
  for(var k=0;k<t.steps.length;k++){ if((t.steps[k].offsetMs||0)<=wall) idx=k; }
  return idx;
}
function stepToVideoTime(t,s,dur){
  if(!dur||!isFinite(dur)||!t.durationMs)return 0;
  return Math.max(0,Math.min(dur,((s.offsetMs||0)/t.durationMs)*dur));
}
function selectStep(i){
  var t=DATA[cur]; if(!t||!t.steps[i])return;
  curStep=i; var s=t.steps[i];
  highlightStep(i); renderInspector(s);
  if(videoMode){
    // In video mode, clicking a step seeks the recording to that moment.
    var vid=document.getElementById('dt-video');
    if(vid) vid.currentTime=stepToVideoTime(t,s,vid.duration);
    return;
  }
  var img=document.getElementById('dt-img'), tap=document.getElementById('dt-tap');
  tap.hidden=true;
  img.onload=function(){ if(curStep===i&&!videoMode&&s.tap) placeTap(s.tap); };
  if(s.img){img.style.display='';img.src=s.img;}else{img.removeAttribute('src');img.style.display='none';}
  if(s.img&&img.complete&&img.naturalWidth&&s.tap) placeTap(s.tap);
}
// Recording: plays inline in the phone, highlighting each step as it reaches it.
function toggleVideo(){
  var t=DATA[cur]; if(!t||!t.video)return;
  var vid=document.getElementById('dt-video'), img=document.getElementById('dt-img'),
      tap=document.getElementById('dt-tap'), btn=document.getElementById('dt-rec-btn');
  videoMode=!videoMode;
  if(videoMode){
    if(!vid.getAttribute('src')) vid.src=t.video;
    img.style.display='none'; tap.hidden=true; vid.hidden=false;
    if(btn)btn.classList.add('on');
    vid.parentElement.style.aspectRatio='9/19.5';
    vid.ontimeupdate=function(){
      var idx=videoTimeToStep(t,vid.currentTime,vid.duration);
      if(idx!==curStep){ curStep=idx; highlightStep(idx); renderInspector(t.steps[idx]); }
    };
    vid.play().catch(function(){});
  }else{
    vid.pause(); vid.hidden=true; img.style.display='';
    if(btn)btn.classList.remove('on');
    selectStep(curStep);
  }
}

// ── routing (deep links + back button) + keyboard ──
function route(){
  var m=(location.hash||'').match(/^#test-(\\d+)$/);
  if(m&&DATA[+m[1]]) showDetail(+m[1],false); else back();
}
window.addEventListener('popstate',route);
document.addEventListener('keydown',function(e){
  if(cur===null)return;
  var t=DATA[cur]; if(!t)return;
  if(e.key==='Escape')back();
  else if(e.key==='ArrowDown'||e.key==='ArrowRight'){e.preventDefault();if(curStep<t.steps.length-1)selectStep(curStep+1);}
  else if(e.key==='ArrowUp'||e.key==='ArrowLeft'){e.preventDefault();if(curStep>0)selectStep(curStep-1);}
});
if(/^#test-\\d+$/.test(location.hash||'')) route();
`;
}
