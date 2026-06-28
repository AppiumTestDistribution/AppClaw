/**
 * Standalone suite report — one self-contained HTML file per runner invocation.
 *
 * Unlike the global `--report` viewer (which indexes *every* historical run),
 * this report is scoped to the CURRENT run only. It aggregates the suite's
 * tests, links each back to its on-disk manifest (steps + screenshots + video)
 * via `runId`, and renders a mobile-focused report: per-device breakdown,
 * per-file grouping, a step gallery with device-framed screenshots, failure
 * reasons, and the run environment.
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
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  retries: number;
  error?: string;
  runId?: string;
  steps: StepArtifact[];
  videoPath?: string;
  /** Relative href prefix to this test's run folder, e.g. `../<runId>` */
  hrefBase?: string;
}

/* ───────────────────────── data assembly ───────────────────────── */

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
        base.steps = manifest.steps ?? [];
        base.videoPath = manifest.videoPath;
        base.hrefBase = `../${r.runId}`;
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
  const total = suite.passed + suite.failed + suite.skipped;
  const ran = suite.passed + suite.failed;
  const passRate = ran > 0 ? Math.round((suite.passed / ran) * 100) : 100;
  const flaky = tests.filter((t) => t.status === 'passed' && t.retries > 0).length;
  const totalSteps = tests.reduce((n, t) => n + t.steps.length, 0);
  const verdict = suite.failed > 0 ? 'FAILED' : 'PASSED';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.suiteName)} · AppClaw Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${styles()}</style>
</head>
<body class="${verdict === 'FAILED' ? 'is-failed' : 'is-passed'}">
<div class="grain"></div>
<main>
  ${renderHero(suite, meta, verdict, passRate, ran)}
  ${renderStats(suite, { total, passRate, flaky, totalSteps, ran })}
  ${renderDevices(meta, tests)}
  ${renderResults(tests)}
  ${renderFooter(meta)}
</main>
<script>${script()}</script>
</body>
</html>`;
}

function renderHero(
  suite: SuiteResult,
  meta: SuiteReportMeta,
  verdict: string,
  passRate: number,
  ran: number
): string {
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
        <span class="chip">${esc(fmtClock(suite.durationMs))} wall</span>
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
        <span class="verdict-sub">${suite.passed}/${ran || suite.passed} passed</span>
      </div>
    </div>
  </header>`;
}

function renderStats(
  suite: SuiteResult,
  d: { total: number; passRate: number; flaky: number; totalSteps: number; ran: number }
): string {
  const tiles: Array<[string, string, string]> = [
    ['tests', String(d.total), 'neutral'],
    ['passed', String(suite.passed), 'pass'],
    ['failed', String(suite.failed), suite.failed ? 'fail' : 'muted'],
    ['flaky', String(d.flaky), d.flaky ? 'flaky' : 'muted'],
    ['skipped', String(suite.skipped), suite.skipped ? 'skip' : 'muted'],
    ['steps', String(d.totalSteps), 'neutral'],
    ['duration', fmtDur(suite.durationMs), 'neutral'],
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
      return `<div class="device-card">
        <div class="device-frame-mini"></div>
        <div class="device-info">
          <div class="device-name">${esc(name)}</div>
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

  let testIndex = 0;
  const groups = [...byFile]
    .map(([file, group]) => {
      const fail = group.filter((t) => t.status === 'failed').length;
      const rows = group.map((t) => renderTest(t, testIndex++)).join('');
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

function renderTest(t: ReportTest, idx: number): string {
  const flaky = t.status === 'passed' && t.retries > 0;
  const tag = flaky ? 'flaky' : t.status;
  const hasDetail = t.steps.length > 0 || !!t.error || !!t.videoPath;
  const stepN = t.steps.length;
  return `<article class="test status-${t.status}${flaky ? ' is-flaky' : ''}" data-status="${t.status}" data-flaky="${flaky}" data-title="${esc(t.title.toLowerCase())}">
    <button class="test-head"${hasDetail ? ' aria-expanded="false"' : ' disabled'} ${hasDetail ? 'onclick="toggleTest(this)"' : ''}>
      <span class="status-glyph s-${t.status}">${
        t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '⊘'
      }</span>
      <span class="test-title">${esc(t.title)}</span>
      <span class="test-tags">
        ${flaky ? `<span class="tag tag-flaky">↻ ${t.retries}</span>` : ''}
        ${t.retries > 0 && !flaky ? `<span class="tag tag-retry">↻ ${t.retries}</span>` : ''}
        <span class="tag tag-device">${esc(t.device)}</span>
        ${stepN ? `<span class="tag tag-steps">${stepN} step${stepN === 1 ? '' : 's'}</span>` : ''}
        <span class="tag tag-time">${esc(fmtDur(t.durationMs))}</span>
      </span>
      ${hasDetail ? '<span class="chevron">⌄</span>' : '<span class="chevron-empty"></span>'}
    </button>
    ${hasDetail ? `<div class="test-body"><div class="test-body-inner">${renderTestBody(t, tag)}</div></div>` : ''}
  </article>`;
}

function renderTestBody(t: ReportTest, _tag: string): string {
  const parts: string[] = [];

  if (t.error) {
    parts.push(`<div class="error-box">
      <div class="error-label">Failure</div>
      <pre class="error-msg">${esc(t.error)}</pre>
    </div>`);
  }

  if (t.videoPath && t.hrefBase) {
    parts.push(`<div class="video-row">
      <a class="video-link" href="${esc(t.hrefBase)}/${esc(t.videoPath)}" target="_blank">▶ screen recording</a>
    </div>`);
  }

  if (t.steps.length) {
    parts.push(
      `<div class="gallery">${t.steps.map((s) => renderStep(s, t.hrefBase)).join('')}</div>`
    );
  } else if (!t.error) {
    parts.push('<div class="no-steps">No captured steps for this test.</div>');
  }

  return parts.join('');
}

function renderStep(s: StepArtifact, hrefBase?: string): string {
  const label = s.target || s.message || s.verbatim || s.kind;
  const shot = s.screenshotPath && hrefBase ? `${hrefBase}/${s.screenshotPath}` : '';
  const overlay = renderTapOverlay(s);
  return `<figure class="step s-${s.status}">
    <div class="phone">
      <div class="phone-screen">
        ${shot ? `<img loading="lazy" src="${esc(shot)}" alt="${esc(label)}">` : '<div class="no-shot">no screenshot</div>'}
        ${overlay}
      </div>
    </div>
    <figcaption>
      <span class="step-kind k-${esc(s.kind)}">${esc(s.kind)}</span>
      <span class="step-label">${esc(label)}</span>
      <span class="step-time">${esc(fmtDur(s.durationMs))}</span>
    </figcaption>
  </figure>`;
}

/** A pulse dot at the tap point, scaled into the screenshot's coordinate box. */
function renderTapOverlay(s: StepArtifact): string {
  if (!s.tapCoordinates || !s.deviceScreenSize) return '';
  const xp = (s.tapCoordinates.x / s.deviceScreenSize.width) * 100;
  const yp = (s.tapCoordinates.y / s.deviceScreenSize.height) * 100;
  if (!Number.isFinite(xp) || !Number.isFinite(yp)) return '';
  return `<span class="tap" style="left:${xp.toFixed(2)}%;top:${yp.toFixed(2)}%"></span>`;
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
  --bg:#0a0c11; --panel:#14171f; --panel-2:#181c26; --line:#242a39;
  --ink:#e8eaf0; --muted:#9298ab; --faint:#5c6377;
  --brand:#FC8EAC; --brand-soft:rgba(252,142,172,.14);
  --pass:#3ddc97; --fail:#ff6b81; --skip:#6b7280; --flaky:#f0b429;
  --r:16px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:
    radial-gradient(1100px 520px at 82% -8%, rgba(252,142,172,.10), transparent 60%),
    radial-gradient(900px 600px at -5% 0%, rgba(61,220,151,.06), transparent 55%),
    var(--bg);
  color:var(--ink);
  font-family:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,sans-serif;
  font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;
  min-height:100vh;
}
body.is-failed{--brand:#FC8EAC}
.grain{position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.035;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
main{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:40px 28px 80px}
code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.85em}

/* reveal */
.reveal{opacity:0;transform:translateY(14px);animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
.stats{animation-delay:.06s}.devices{animation-delay:.12s}.results{animation-delay:.18s}.footer{animation-delay:.24s}
@keyframes rise{to{opacity:1;transform:none}}

/* hero */
.hero{display:flex;justify-content:space-between;gap:32px;align-items:flex-start;
  padding:30px 30px;border:1px solid var(--line);border-radius:24px;
  background:linear-gradient(160deg,var(--panel-2),var(--panel));
  box-shadow:0 30px 80px -40px rgba(0,0,0,.8);position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:
  linear-gradient(90deg,var(--brand),transparent 40%);opacity:.08}
.brand{font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.18em;
  text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:8px}
.brand-mark{color:var(--brand);font-size:15px}
.brand-sub{color:var(--faint)}
.suite{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;
  font-size:clamp(30px,5vw,52px);line-height:1.02;letter-spacing:-.02em;margin:14px 0 16px;
  background:linear-gradient(180deg,#fff,#c8cbd6);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero-meta{display:flex;flex-wrap:wrap;gap:8px}
.chip{font-family:"IBM Plex Mono",monospace;font-size:12px;padding:5px 11px;border-radius:999px;
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
.rate{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-size:30px;line-height:1}
.rate span{font-size:14px;color:var(--muted)}
.rate-label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-top:2px}
.verdict{display:flex;align-items:center;gap:9px;font-family:"Bricolage Grotesque",sans-serif;
  font-weight:800;font-size:18px;letter-spacing:.04em;padding:8px 16px;border-radius:12px;border:1px solid var(--line)}
.verdict .dot{width:9px;height:9px;border-radius:50%}
.verdict-sub{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:500;color:var(--muted);letter-spacing:0}
.verdict-passed{color:var(--pass)}.verdict-passed .dot{background:var(--pass);box-shadow:0 0 14px var(--pass)}
.verdict-failed{color:var(--fail)}.verdict-failed .dot{background:var(--fail);box-shadow:0 0 14px var(--fail)}

/* stats */
.stats{display:grid;grid-template-columns:repeat(7,1fr);gap:12px;margin-top:18px}
.tile{border:1px solid var(--line);border-radius:var(--r);padding:18px 16px;background:var(--panel);
  position:relative;overflow:hidden}
.tile::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--faint);opacity:.6}
.tile-value{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-size:30px;line-height:1;letter-spacing:-.01em}
.tile-label{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-top:8px}
.tone-pass .tile-value{color:var(--pass)}.tone-pass::after{background:var(--pass)}
.tone-fail .tile-value{color:var(--fail)}.tone-fail::after{background:var(--fail)}
.tone-flaky .tile-value{color:var(--flaky)}.tone-flaky::after{background:var(--flaky)}
.tone-skip .tile-value{color:var(--skip)}.tone-skip::after{background:var(--skip)}
.tone-neutral::after{background:var(--brand)}
.tone-muted{opacity:.55}

/* section */
.section-title{font-family:"Bricolage Grotesque",sans-serif;font-weight:700;font-size:20px;
  margin:0 0 16px;display:flex;align-items:center;gap:10px}
.section-title .count,.file-count{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--muted);
  border:1px solid var(--line);border-radius:999px;padding:2px 9px}
.devices{margin-top:36px}
.device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.device-card{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:14px;
  padding:12px 14px;background:var(--panel)}
.device-frame-mini{width:26px;height:44px;border-radius:6px;border:2px solid var(--faint);flex-shrink:0;position:relative;
  background:linear-gradient(160deg,#222838,#11141c)}
.device-frame-mini::after{content:"";position:absolute;left:50%;top:4px;transform:translateX(-50%);width:8px;height:2px;border-radius:2px;background:var(--faint)}
.device-name{font-family:"IBM Plex Mono",monospace;font-size:13px;font-weight:600}
.device-stats{display:flex;gap:10px;font-size:12px;margin-top:3px}
.device-stats .pass{color:var(--pass)}.device-stats .fail{color:var(--fail)}.faint{color:var(--faint)}

/* results */
.results{margin-top:40px}
.results-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.results-head .section-title{margin:0}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.search{font-family:"IBM Plex Mono",monospace;font-size:13px;background:var(--panel);border:1px solid var(--line);
  color:var(--ink);padding:8px 13px;border-radius:10px;width:190px;outline:none}
.search:focus{border-color:var(--brand)}
.filters{display:flex;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:3px}
.filter{font-family:"IBM Plex Sans",sans-serif;font-size:13px;font-weight:500;color:var(--muted);background:none;
  border:none;padding:6px 13px;border-radius:7px;cursor:pointer;transition:.15s}
.filter:hover{color:var(--ink)}
.filter.active{background:var(--brand);color:#1a0f14;font-weight:600}

.file-group{margin-bottom:20px}
.file-head{display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid var(--line);margin-bottom:8px}
.file-icon{color:var(--brand)}
.file-path{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--ink);font-weight:500}
.file-badge{font-size:11px;padding:2px 9px;border-radius:999px;font-weight:600}
.file-badge.all-pass{color:var(--pass);background:rgba(61,220,151,.1)}
.file-badge.has-fail{color:var(--fail);background:rgba(255,107,129,.1)}
.file-count{margin-left:auto}

.test{border:1px solid var(--line);border-radius:13px;background:var(--panel);margin-bottom:8px;overflow:hidden;transition:border-color .2s}
.test.status-failed{border-color:rgba(255,107,129,.35)}
.test:hover{border-color:rgba(255,255,255,.16)}
.test-head{width:100%;display:flex;align-items:center;gap:13px;padding:14px 16px;background:none;border:none;
  color:var(--ink);cursor:pointer;text-align:left;font-family:inherit;font-size:14.5px}
.test-head[disabled]{cursor:default}
.status-glyph{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;font-size:12px;flex-shrink:0;font-weight:700}
.s-passed{background:rgba(61,220,151,.16);color:var(--pass)}
.s-failed{background:rgba(255,107,129,.16);color:var(--fail)}
.s-skipped{background:rgba(107,114,128,.16);color:var(--skip)}
.test-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.test-tags{display:flex;gap:6px;align-items:center;flex-shrink:0}
.tag{font-family:"IBM Plex Mono",monospace;font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.tag-device{color:var(--ink)}
.tag-flaky{color:var(--flaky);border-color:rgba(240,180,41,.4)}
.tag-retry{color:var(--flaky)}
.tag-time{color:var(--brand);border-color:rgba(252,142,172,.3)}
.chevron{color:var(--faint);transition:transform .25s;font-size:16px}
.chevron-empty{width:16px;display:inline-block}
.test.open .chevron{transform:rotate(180deg)}

.test-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s ease}
.test.open .test-body{grid-template-rows:1fr}
.test-body-inner{overflow:hidden;min-height:0}
.test.open .test-body-inner{padding:4px 16px 18px}

.error-box{border:1px solid rgba(255,107,129,.3);border-radius:10px;background:rgba(255,107,129,.06);padding:12px 14px;margin:8px 0 14px}
.error-label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--fail);font-weight:600;margin-bottom:6px}
.error-msg{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:#ffd2d9;margin:0;white-space:pre-wrap;word-break:break-word}
.video-row{margin:6px 0 14px}
.video-link{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--brand);text-decoration:none;border:1px solid rgba(252,142,172,.3);padding:6px 12px;border-radius:8px}
.video-link:hover{background:var(--brand-soft)}
.no-steps,.no-shot{color:var(--faint);font-size:13px;font-style:italic}

/* step gallery — device-framed screenshots */
.gallery{display:flex;gap:16px;overflow-x:auto;padding:8px 2px 14px;scroll-snap-type:x proximity}
.gallery::-webkit-scrollbar{height:8px}.gallery::-webkit-scrollbar-thumb{background:var(--line);border-radius:8px}
.step{margin:0;flex-shrink:0;width:172px;scroll-snap-align:start}
.phone{padding:7px;border-radius:22px;background:linear-gradient(160deg,#262d3e,#0f121a);
  border:1px solid #313a4f;box-shadow:0 14px 30px -16px rgba(0,0,0,.9)}
.phone-screen{position:relative;border-radius:15px;overflow:hidden;background:#000;aspect-ratio:9/19.5}
.phone-screen img{width:100%;height:100%;object-fit:cover;display:block}
.no-shot{display:grid;place-items:center;height:100%;color:var(--faint)}
.tap{position:absolute;width:26px;height:26px;border-radius:50%;transform:translate(-50%,-50%);
  border:2px solid var(--brand);background:rgba(252,142,172,.25);box-shadow:0 0 0 0 rgba(252,142,172,.5);
  animation:tap 1.8s ease-out infinite}
@keyframes tap{0%{box-shadow:0 0 0 0 rgba(252,142,172,.5)}70%{box-shadow:0 0 0 16px rgba(252,142,172,0)}100%{box-shadow:0 0 0 0 rgba(252,142,172,0)}}
figcaption{display:flex;align-items:center;gap:7px;margin-top:9px;font-size:11.5px}
.step-kind{font-family:"IBM Plex Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:.05em;
  padding:2px 6px;border-radius:5px;background:var(--panel-2);border:1px solid var(--line);color:var(--muted)}
.step.s-failed .step-kind{color:var(--fail);border-color:rgba(255,107,129,.4)}
.step.s-passed .step-kind{color:var(--pass)}
.step-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.step-time{color:var(--faint);font-family:"IBM Plex Mono",monospace}

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
function toggleTest(btn){
  var t=btn.closest('.test');
  var open=t.classList.toggle('open');
  btn.setAttribute('aria-expanded',open?'true':'false');
}
(function(){
  var filter='all', q='';
  var groups=document.getElementById('groups');
  var empty=document.getElementById('empty');
  function apply(){
    var any=false;
    document.querySelectorAll('.test').forEach(function(t){
      var s=t.dataset.status, fl=t.dataset.flaky==='true', title=t.dataset.title||'';
      var mf = filter==='all' || (filter==='flaky'?fl:s===filter);
      var mq = !q || title.indexOf(q)>-1;
      var show = mf && mq;
      t.style.display = show?'':'none';
      if(show) any=true;
    });
    document.querySelectorAll('.file-group').forEach(function(g){
      var vis=[].some.call(g.querySelectorAll('.test'),function(t){return t.style.display!=='none'});
      g.style.display=vis?'':'none';
    });
    empty.hidden=any;
  }
  document.querySelectorAll('.filter').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.filter').forEach(function(x){x.classList.remove('active')});
      b.classList.add('active'); filter=b.dataset.filter; apply();
    });
  });
  var s=document.getElementById('search');
  s.addEventListener('input',function(){q=s.value.trim().toLowerCase();apply();});
  // Auto-open the first failed test so failures are immediately visible.
  var firstFail=document.querySelector('.test.status-failed .test-head:not([disabled])');
  if(firstFail) toggleTest(firstFail);
})();`;
}
