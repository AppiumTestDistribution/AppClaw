/**
 * HTML renderer — server-side rendered pages for AppClaw flow execution reports.
 *
 * Produces complete HTML strings with embedded CSS and JS.
 * No build step required — pure template strings.
 */

import type { RunIndex, RunIndexEntry, RunManifest, StepArtifact, SuiteEntry } from './types.js';
import type { FlowPhase } from '../flow/types.js';

/* ─── Helpers ────────────────────────────────────────────── */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function successRate(runs: RunIndexEntry[]): number {
  if (runs.length === 0) return 0;
  return (runs.filter((r) => r.success).length / runs.length) * 100;
}

function phaseLabel(phase: FlowPhase): string {
  switch (phase) {
    case 'setup':
      return 'Setup';
    case 'test':
      return 'Test';
    case 'assertion':
      return 'Assertion';
  }
}

function stepKindLabel(kind: string): string {
  switch (kind) {
    case 'tap':
      return 'Tap';
    case 'type':
      return 'Type';
    case 'assert':
      return 'Assert';
    case 'scrollAssert':
      return 'Scroll Assert';
    case 'swipe':
      return 'Swipe';
    case 'wait':
      return 'Wait';
    case 'waitUntil':
      return 'Wait Until';
    case 'openApp':
    case 'launchApp':
      return 'Launch';
    case 'back':
      return 'Back';
    case 'home':
      return 'Home';
    case 'enter':
      return 'Enter';
    case 'getInfo':
      return 'Get Info';
    case 'done':
      return 'Done';
    default:
      return kind;
  }
}

/* ─── Font ───────────────────────────────────────────────── */

function fontLinks(): string {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;
}

/* ─── Theme Script ───────────────────────────────────────── */

function themeScript(): string {
  return `<script>
    (function() {
      var saved = localStorage.getItem('appclaw-theme') || 'dark';
      document.documentElement.setAttribute('data-theme', saved);
      updateToggle(saved);
    })();
    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('appclaw-theme', theme);
      updateToggle(theme);
    }
    function updateToggle(theme) {
      var light = document.getElementById('theme-light');
      var dark = document.getElementById('theme-dark');
      if (light) light.className = theme === 'light' ? 'active' : '';
      if (dark) dark.className = theme === 'dark' ? 'active' : '';
    }
  </script>`;
}

/* ─── Shared CSS with Light/Dark Theme ───────────────────── */

function sharedCss(): string {
  return `
    :root, [data-theme="dark"] {
      --bg-root: #0b0c11;
      --bg-surface: #13141c;
      --bg-elevated: #1b1d28;
      --bg-inset: #0b0c11;
      --bg-hover: rgba(129, 140, 248, 0.05);
      --bg-active: rgba(129, 140, 248, 0.1);

      --accent: #818cf8;
      --accent-dim: rgba(129, 140, 248, 0.15);
      --accent-border: rgba(129, 140, 248, 0.3);
      --accent-glow: rgba(129, 140, 248, 0.15);

      --success: #34d399;
      --success-dim: rgba(52, 211, 153, 0.1);
      --success-border: rgba(52, 211, 153, 0.25);
      --success-bg: rgba(52, 211, 153, 0.06);
      --failure: #f87171;
      --failure-dim: rgba(248, 113, 113, 0.1);
      --failure-border: rgba(248, 113, 113, 0.25);
      --failure-bg: rgba(248, 113, 113, 0.06);
      --warning: #fbbf24;
      --warning-dim: rgba(251, 191, 36, 0.12);

      --text-primary: #f0f1f8;
      --text-secondary: #9699b0;
      --text-tertiary: #50546a;
      --text-on-success: #0b0c11;
      --text-on-failure: #0b0c11;

      --border: rgba(255, 255, 255, 0.07);
      --border-emphasis: rgba(255, 255, 255, 0.13);

      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --radius-xl: 20px;

      --shadow-sm: 0 1px 3px rgba(0,0,0,0.4);
      --shadow-md: 0 4px 20px rgba(0,0,0,0.4);
      --shadow-lg: 0 8px 40px rgba(0,0,0,0.5);

      --brand-mark-bg: linear-gradient(135deg, #818cf8, #a78bfa);
      --brand-mark-color: #0b0c11;
      --screenshot-border: rgba(255,255,255,0.06);
    }

    [data-theme="light"] {
      --bg-root: #f5f5f9;
      --bg-surface: #ffffff;
      --bg-elevated: #ebebf4;
      --bg-inset: #eeeef6;
      --bg-hover: rgba(99, 102, 241, 0.05);
      --bg-active: rgba(99, 102, 241, 0.09);

      --accent: #6366f1;
      --accent-dim: rgba(99, 102, 241, 0.1);
      --accent-border: rgba(99, 102, 241, 0.3);
      --accent-glow: rgba(99, 102, 241, 0.1);

      --success: #059669;
      --success-dim: rgba(5, 150, 105, 0.1);
      --success-border: rgba(5, 150, 105, 0.25);
      --success-bg: rgba(5, 150, 105, 0.07);
      --failure: #dc2626;
      --failure-dim: rgba(220, 38, 38, 0.09);
      --failure-border: rgba(220, 38, 38, 0.25);
      --failure-bg: rgba(220, 38, 38, 0.05);
      --warning: #d97706;
      --warning-dim: rgba(217, 119, 6, 0.1);

      --text-primary: #12131e;
      --text-secondary: #4b4f6e;
      --text-tertiary: #9096b4;
      --text-on-success: #ffffff;
      --text-on-failure: #ffffff;

      --border: rgba(18, 19, 30, 0.09);
      --border-emphasis: rgba(18, 19, 30, 0.16);

      --shadow-sm: 0 1px 3px rgba(0,0,0,0.07);
      --shadow-md: 0 4px 20px rgba(0,0,0,0.08);
      --shadow-lg: 0 8px 40px rgba(0,0,0,0.1);

      --brand-mark-bg: linear-gradient(135deg, #6366f1, #8b5cf6);
      --brand-mark-color: #ffffff;
      --screenshot-border: rgba(0,0,0,0.1);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg-root);
      color: var(--text-primary);
      font-family: 'Sora', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      transition: background 0.3s, color 0.3s;
    }

    .page {
      max-width: 1320px;
      margin: 0 auto;
      padding: 32px 32px 64px;
    }

    a { color: var(--accent); text-decoration: none; transition: opacity 0.15s; }
    a:hover { opacity: 0.8; }

    /* ── Animations ── */
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .animate-in { animation: fadeInUp 0.35s ease-out both; }
    .animate-in-1 { animation-delay: 0.04s; }
    .animate-in-2 { animation-delay: 0.08s; }
    .animate-in-3 { animation-delay: 0.12s; }
    .animate-in-4 { animation-delay: 0.16s; }
    .animate-in-5 { animation-delay: 0.2s; }

    /* ── Status Pill ── */
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .status-pill.success {
      background: var(--success-dim);
      color: var(--success);
      border: 1px solid var(--success-border);
    }
    .status-pill.failure {
      background: var(--failure-dim);
      color: var(--failure);
      border: 1px solid var(--failure-border);
    }
    .status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.success { background: var(--success); }
    .status-dot.failure { background: var(--failure); }

    /* ── Brand ── */
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'Lora', Georgia, serif;
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }
    .brand-mark {
      width: 34px; height: 34px;
      border-radius: 9px;
      background: var(--brand-mark-bg);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Sora', sans-serif;
      font-size: 16px; font-weight: 700; color: var(--brand-mark-color);
    }

    /* ── Theme Toggle ── */
    .theme-toggle {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
    }
    .theme-toggle button {
      padding: 5px 10px;
      border: none;
      border-radius: 6px;
      font-family: 'Sora', sans-serif;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      background: transparent;
      color: var(--text-tertiary);
      display: flex;
      align-items: center;
      gap: 5px;
      line-height: 1;
    }
    .theme-toggle button.active {
      background: var(--accent-dim);
      color: var(--accent);
    }
    .theme-toggle button:hover:not(.active) { color: var(--text-secondary); }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  `;
}

/* ─── SVG Icons ──────────────────────────────────────────── */

function iconClock(): string {
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
}
function iconArrowLeft(): string {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
}
function iconDevice(): string {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
}
function iconAndroid(): string {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.532 15.106a1.003 1.003 0 1 1 .001-2.007 1.003 1.003 0 0 1 0 2.007zm-11.063 0a1.003 1.003 0 1 1 .001-2.007 1.003 1.003 0 0 1 0 2.007zm11.371-4.464 1.977-3.424a.41.41 0 0 0-.15-.56.41.41 0 0 0-.56.15L17.1 10.255a12.63 12.63 0 0 0-5.1-1.033 12.63 12.63 0 0 0-5.1 1.033L4.893 6.808a.41.41 0 0 0-.56-.15.41.41 0 0 0-.15.56l1.977 3.424C2.565 12.736.002 16.412.002 20.6h24c0-4.188-2.563-7.864-6.162-9.958z"/></svg>';
}
function iconApple(): string {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>';
}
function iconSteps(): string {
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
}

/* ─── Health Summary ─────────────────────────────────────── */

function healthSummary(runs: RunIndexEntry[]): { headline: string; sub: string; cls: string } {
  if (runs.length === 0) {
    return {
      headline: 'No runs recorded yet',
      sub: 'Run a YAML flow to see results here.',
      cls: 'neutral',
    };
  }
  const passed = runs.filter((r) => r.success).length;
  const failed = runs.length - passed;
  const latest = runs[0];
  const latestName = latest.flowName || latest.flowFile.split('/').pop() || latest.runId;
  const latestDate = formatDateShort(latest.startedAt);

  if (failed === 0) {
    return {
      headline: `All ${runs.length} run${runs.length !== 1 ? 's' : ''} passed`,
      sub: `Latest: ${latestName} — ${latestDate}`,
      cls: 'all-passed',
    };
  }
  if (passed === 0) {
    return {
      headline: `All ${runs.length} run${runs.length !== 1 ? 's' : ''} failed`,
      sub: `Latest failure: ${latestName} — ${latestDate}`,
      cls: 'all-failed',
    };
  }
  return {
    headline: `${failed} of ${runs.length} run${runs.length !== 1 ? 's' : ''} failed`,
    sub: `${passed} passed · ${failed} need attention`,
    cls: 'partial',
  };
}

/* ─── Run Index Page ─────────────────────────────────────── */

export function renderIndexPage(index: RunIndex): string {
  const runs = index.runs;
  const rate = successRate(runs);
  const failed = runs.filter((r) => !r.success).length;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AppClaw Reports</title>
  <script>(function(){var t=localStorage.getItem('appclaw-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
  ${fontLinks()}
  <style>
    ${sharedCss()}

    /* ── Page Header ── */
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .page-header .subtitle {
      color: var(--text-tertiary);
      font-size: 13px;
      margin-top: 4px;
      font-weight: 400;
      letter-spacing: 0.01em;
    }

    /* ── Health Banner ── */
    .health-banner {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 20px 24px;
      border-radius: var(--radius-lg);
      margin-bottom: 20px;
      border: 1px solid;
    }
    .health-banner.all-passed {
      background: var(--success-bg);
      border-color: var(--success-border);
    }
    .health-banner.all-failed {
      background: var(--failure-bg);
      border-color: var(--failure-border);
    }
    .health-banner.partial {
      background: var(--failure-bg);
      border-color: var(--failure-border);
    }
    .health-banner.neutral {
      background: var(--bg-elevated);
      border-color: var(--border);
    }
    .health-icon {
      width: 40px; height: 40px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      font-size: 20px;
    }
    .health-banner.all-passed .health-icon { background: var(--success-dim); color: var(--success); }
    .health-banner.all-failed .health-icon { background: var(--failure-dim); color: var(--failure); }
    .health-banner.partial .health-icon { background: var(--failure-dim); color: var(--failure); }
    .health-banner.neutral .health-icon { background: var(--bg-inset); color: var(--text-tertiary); }
    .health-headline {
      font-family: 'Lora', Georgia, serif;
      font-size: 18px;
      font-weight: 600;
      line-height: 1.2;
    }
    .health-banner.all-passed .health-headline { color: var(--success); }
    .health-banner.all-failed .health-headline, .health-banner.partial .health-headline { color: var(--failure); }
    .health-banner.neutral .health-headline { color: var(--text-primary); }
    .health-sub {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 3px;
    }

    /* ── Stat Cards ── */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      padding: 18px 20px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      transition: border-color 0.2s;
    }
    .stat-card:hover { border-color: var(--border-emphasis); }
    .stat-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .stat-value {
      font-family: 'Lora', Georgia, serif;
      font-size: 28px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1;
    }
    .stat-value.success { color: var(--success); }
    .stat-value.failure { color: var(--failure); }
    .stat-bar {
      margin-top: 10px;
      height: 3px;
      border-radius: 3px;
      background: var(--bg-elevated);
      overflow: hidden;
    }
    .stat-bar-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--success);
      transition: width 0.6s ease-out;
    }
    .stat-bar-fill.low { background: var(--failure); }
    .stat-bar-fill.mid { background: var(--warning); }

    /* ── Run List ── */
    .runs-panel {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      overflow: hidden;
    }
    .runs-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 18px 24px;
      border-bottom: 1px solid var(--border);
    }
    .runs-header h2 {
      font-family: 'Lora', Georgia, serif;
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .runs-count {
      font-size: 12px;
      color: var(--text-tertiary);
      padding: 3px 10px;
      background: var(--bg-elevated);
      border-radius: 999px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    /* ── Run Row ── */
    .run-item {
      display: grid;
      grid-template-columns: 3px 1fr 110px 130px 80px 100px;
      align-items: center;
      gap: 16px;
      padding: 0 24px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background 0.12s;
      text-decoration: none;
      color: inherit;
      min-height: 64px;
    }
    .run-item:hover { background: var(--bg-hover); opacity: 1; }
    .run-item:last-child { border-bottom: none; }
    .run-item.failed-row { background: var(--failure-bg); }
    .run-item.failed-row:hover { background: rgba(248,113,113,0.09); }

    .run-status-bar {
      align-self: stretch;
      width: 3px;
      border-radius: 0;
      flex-shrink: 0;
    }
    .run-status-bar.success { background: var(--success); }
    .run-status-bar.failure { background: var(--failure); }

    .run-info { min-width: 0; padding: 14px 0; }
    .run-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .run-file {
      font-size: 12px;
      color: var(--text-tertiary);
      margin-top: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: 'JetBrains Mono', monospace;
    }
    .run-failure-hint {
      font-size: 12px;
      color: var(--failure);
      margin-top: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: 0.85;
    }
    .run-failure-hint::before { content: "↳ "; }

    .run-platform {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      padding: 4px 10px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      width: fit-content;
    }

    .run-date {
      font-size: 13px;
      color: var(--text-secondary);
    }
    .run-duration {
      font-size: 13px;
      color: var(--text-secondary);
      font-family: 'JetBrains Mono', monospace;
      font-variant-numeric: tabular-nums;
    }
    .run-steps-progress {
      font-size: 12px;
      color: var(--text-tertiary);
      font-family: 'JetBrains Mono', monospace;
    }

    .empty-state {
      padding: 56px 32px;
      text-align: center;
      color: var(--text-tertiary);
    }
    .empty-state p { font-size: 14px; margin-bottom: 8px; }
    .empty-state code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      padding: 2px 8px;
      background: var(--bg-elevated);
      border-radius: 6px;
      color: var(--accent);
    }

    /* ── Column Headers ── */
    .run-list-header {
      display: grid;
      grid-template-columns: 3px 1fr 110px 130px 80px 100px;
      gap: 16px;
      padding: 9px 24px;
      background: var(--bg-inset);
      border-bottom: 1px solid var(--border);
    }
    .col-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    /* ── Suite Groups ── */
    .suite-group { border-bottom: 1px solid var(--border); }
    .suite-group:last-child { border-bottom: none; }

    .suite-row {
      display: grid;
      grid-template-columns: 3px 1fr 110px 130px 80px 100px;
      align-items: center;
      gap: 16px;
      padding: 14px 24px;
      cursor: pointer;
      transition: background 0.12s;
      user-select: none;
      background: var(--bg-inset);
      min-height: 60px;
    }
    .suite-row:hover { background: var(--bg-hover); }

    .suite-name {
      font-weight: 700;
      font-size: 14px;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .suite-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid var(--accent-border);
    }
    .suite-meta { font-size: 12px; color: var(--text-tertiary); margin-top: 2px; }
    .suite-toggle {
      color: var(--text-tertiary);
      font-size: 11px;
      transition: transform 0.2s;
      display: flex; align-items: center; justify-content: center;
    }
    .suite-toggle.open { transform: rotate(90deg); }
    .suite-children { display: none; }
    .suite-children.expanded { display: block; }

    .suite-child-run {
      display: grid;
      grid-template-columns: 3px 1fr 110px 130px 80px 100px;
      align-items: center;
      gap: 16px;
      padding: 0 24px 0 44px;
      border-top: 1px solid var(--border);
      cursor: pointer;
      transition: background 0.12s;
      text-decoration: none;
      color: inherit;
      min-height: 56px;
    }
    .suite-child-run:hover { background: var(--bg-hover); opacity: 1; }
    .suite-child-run.failed-row { background: var(--failure-bg); }
    .suite-child-run.failed-row:hover { background: rgba(248,113,113,0.09); }

    .child-run-info { min-width: 0; padding: 12px 0; }
    .child-run-name {
      font-weight: 500;
      font-size: 13px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .child-run-device {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 2px;
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    @media (max-width: 960px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .run-item, .run-list-header, .suite-row, .suite-child-run {
        grid-template-columns: 3px 1fr auto auto;
      }
      .run-date, .run-steps-progress, .run-duration { display: none; }
    }
    @media (max-width: 600px) {
      .stats-row { grid-template-columns: 1fr 1fr; }
      .page { padding: 16px 16px 48px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <!-- Header -->
    <header class="page-header animate-in">
      <div>
        <div class="brand">
          <div class="brand-mark">A</div>
          AppClaw Reports
        </div>
        <p class="subtitle">Flow execution history</p>
      </div>
      <div class="theme-toggle" id="theme-toggle">
        <button id="theme-light" onclick="setTheme('light')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          Light
        </button>
        <button id="theme-dark" onclick="setTheme('dark')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          Dark
        </button>
      </div>
    </header>

    <!-- Health Banner -->
    ${(() => {
      const h = healthSummary(runs);
      const icon =
        h.cls === 'all-passed'
          ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
          : h.cls === 'neutral'
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      return `<div class="health-banner ${h.cls} animate-in animate-in-1">
        <div class="health-icon">${icon}</div>
        <div>
          <div class="health-headline">${escapeHtml(h.headline)}</div>
          <div class="health-sub">${escapeHtml(h.sub)}</div>
        </div>
      </div>`;
    })()}

    <!-- Stats -->
    <section class="stats-row animate-in animate-in-2">
      <div class="stat-card">
        <div class="stat-label">Total Runs</div>
        <div class="stat-value">${runs.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pass Rate</div>
        <div class="stat-value ${rate >= 80 ? 'success' : rate >= 50 ? '' : 'failure'}">${rate.toFixed(0)}%</div>
        <div class="stat-bar">
          <div class="stat-bar-fill ${rate >= 80 ? '' : rate >= 50 ? 'mid' : 'low'}" style="width:${rate.toFixed(0)}%"></div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Passed</div>
        <div class="stat-value success">${runs.filter((r) => r.success).length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Failed</div>
        <div class="stat-value ${failed > 0 ? 'failure' : ''}">${failed}</div>
      </div>
    </section>

    <!-- Run List -->
    <section class="runs-panel animate-in animate-in-3">
      <div class="runs-header">
        <h2>Run History</h2>
        <span class="runs-count">${runs.length} run${runs.length !== 1 ? 's' : ''}</span>
      </div>
      ${
        runs.length === 0
          ? `<div class="empty-state">
            <p>No flow runs recorded yet.</p>
            <p>Run a YAML flow with <code>appclaw --flow</code> to get started.</p>
          </div>`
          : `<div class="run-list-header">
            <span></span>
            <span class="col-label">Flow</span>
            <span class="col-label">Platform</span>
            <span class="col-label">Date</span>
            <span class="col-label">Duration</span>
            <span class="col-label">Status</span>
          </div>
          ${renderRunList(runs, index.suites ?? [])}`
      }
    </section>
  </main>
  <script>
    function toggleSuite(suiteId) {
      var children = document.getElementById('suite-children-' + suiteId);
      var toggle = document.getElementById('suite-toggle-' + suiteId);
      var expanded = children.classList.contains('expanded');
      if (expanded) {
        children.classList.remove('expanded');
        toggle.classList.remove('open');
      } else {
        children.classList.add('expanded');
        toggle.classList.add('open');
      }
    }
  </script>
  ${themeScript()}
</body>
</html>`;
}

/** Build the ordered display list — suite groups first, then standalone runs, maintaining recency order. */
function renderRunList(runs: RunIndexEntry[], suites: SuiteEntry[]): string {
  const suiteMap = new Map<string, SuiteEntry>(suites.map((s) => [s.suiteId, s]));
  const seenSuiteIds = new Set<string>();
  const html: string[] = [];

  for (const run of runs) {
    if (run.suiteId) {
      if (!seenSuiteIds.has(run.suiteId)) {
        seenSuiteIds.add(run.suiteId);
        const childRuns = runs.filter((r) => r.suiteId === run.suiteId);
        const suite = suiteMap.get(run.suiteId);
        html.push(renderSuiteGroup(run.suiteId, run.suiteName, suite, childRuns));
      }
      // else already rendered as part of a group
    } else {
      html.push(renderRunRow(run));
    }
  }

  return html.join('');
}

function renderSuiteGroup(
  suiteId: string,
  suiteName: string | undefined,
  suite: SuiteEntry | undefined,
  childRuns: RunIndexEntry[]
): string {
  const allPassed = childRuns.every((r) => r.success);
  const cls = allPassed ? 'success' : 'failure';
  const platform = suite?.platform ?? childRuns[0]?.platform ?? 'android';
  const platformIcon = platform === 'ios' ? iconApple() : iconAndroid();
  const startedAt = suite?.startedAt ?? childRuns[0]?.startedAt ?? '';
  const durationMs = suite?.durationMs ?? childRuns.reduce((s, r) => s + r.durationMs, 0);
  const passedCount = suite?.passedCount ?? childRuns.filter((r) => r.success).length;
  const totalCount = childRuns.length;
  const displayName = suiteName ?? 'Suite';
  const escapedSuiteId = escapeHtml(suiteId);
  const statusLabel = allPassed
    ? `All ${passedCount} passed`
    : `${passedCount}/${totalCount} passed`;
  const statusCls = allPassed ? 'success' : 'failure';

  return `
    <div class="suite-group">
      <div class="suite-row" onclick="toggleSuite('${escapedSuiteId}')">
        <div class="run-status-bar ${cls}"></div>
        <div>
          <div class="suite-name">${escapeHtml(displayName)} <span class="suite-badge">Suite</span></div>
          <div class="suite-meta">${totalCount} flow${totalCount !== 1 ? 's' : ''}</div>
        </div>
        <span class="run-platform">${platformIcon} ${escapeHtml(platform)}</span>
        <span class="run-date">${startedAt ? escapeHtml(formatDateShort(startedAt)) : '—'}</span>
        <span class="run-duration">${escapeHtml(formatDuration(durationMs))}</span>
        <div style="display:flex;align-items:center;gap:8px;justify-content:flex-start">
          <span class="status-pill ${statusCls}"><span class="status-dot ${statusCls}"></span>${escapeHtml(statusLabel)}</span>
          <span class="suite-toggle" id="suite-toggle-${escapedSuiteId}">▶</span>
        </div>
      </div>
      <div class="suite-children" id="suite-children-${escapedSuiteId}">
        ${childRuns.map(renderChildRunRow).join('')}
      </div>
    </div>`;
}

function renderChildRunRow(run: RunIndexEntry): string {
  const name = run.flowName || run.flowFile.split('/').pop() || run.runId;
  const cls = run.success ? 'success' : 'failure';
  const failedCls = !run.success ? ' failed-row' : '';
  const platformIcon = run.platform === 'ios' ? iconApple() : iconAndroid();
  const failureHint =
    !run.success && run.device
      ? `<div class="run-failure-hint">Failed on ${escapeHtml(run.device)}</div>`
      : '';
  return `
    <a class="suite-child-run${failedCls}" href="/runs/${escapeHtml(run.runId)}">
      <div class="run-status-bar ${cls}"></div>
      <div class="child-run-info">
        <div class="child-run-name">${escapeHtml(name)}</div>
        <div class="child-run-device">${run.device ? escapeHtml(run.device) : escapeHtml(run.flowFile.split('/').pop() || run.flowFile)}</div>
        ${failureHint}
      </div>
      <span class="run-platform">${platformIcon} ${escapeHtml(run.platform)}</span>
      <span class="run-date">${escapeHtml(formatDateShort(run.startedAt))}</span>
      <span class="run-duration">${escapeHtml(formatDuration(run.durationMs))}</span>
      ${renderStatusPill(run.success)}
    </a>`;
}

function renderRunRow(run: RunIndexEntry): string {
  const name = run.flowName || run.flowFile.split('/').pop() || run.runId;
  const cls = run.success ? 'success' : 'failure';
  const failedCls = !run.success ? ' failed-row' : '';
  const platformIcon = run.platform === 'ios' ? iconApple() : iconAndroid();
  const failureHint = !run.success
    ? `<div class="run-failure-hint">Failed at step ${run.stepsExecuted} of ${run.stepsTotal}${run.failedPhase ? ` (${run.failedPhase})` : ''}</div>`
    : '';
  return `
    <a class="run-item${failedCls}" href="/runs/${escapeHtml(run.runId)}">
      <div class="run-status-bar ${cls}"></div>
      <div class="run-info">
        <div class="run-name">${escapeHtml(name)}</div>
        <div class="run-file">${escapeHtml(run.device || run.flowFile)}</div>
        ${failureHint}
      </div>
      <span class="run-platform">${platformIcon} ${escapeHtml(run.platform)}</span>
      <span class="run-date">${escapeHtml(formatDateShort(run.startedAt))}</span>
      <span class="run-duration">${escapeHtml(formatDuration(run.durationMs))}</span>
      ${renderStatusPill(run.success)}
    </a>`;
}

function renderStatusPill(success: boolean): string {
  const cls = success ? 'success' : 'failure';
  const label = success ? 'Passed' : 'Failed';
  return `<span class="status-pill ${cls}"><span class="status-dot ${cls}"></span>${label}</span>`;
}

/* ─── Run Detail Page ────────────────────────────────────── */

export function renderRunPage(manifest: RunManifest): string {
  const name = manifest.meta.name || manifest.flowFile.split('/').pop() || manifest.runId;
  const hasPhases = manifest.phaseResults && manifest.phaseResults.length > 0;
  const platformIcon = manifest.platform === 'ios' ? iconApple() : iconAndroid();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)} — AppClaw Report</title>
  <script>(function(){var t=localStorage.getItem('appclaw-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
  ${fontLinks()}
  <style>
    ${sharedCss()}

    /* ── Run Header ── */
    .run-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      margin-bottom: 20px;
    }
    .run-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .back-btn {
      width: 34px; height: 34px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--radius-md);
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .back-btn:hover {
      border-color: var(--accent-border);
      color: var(--accent);
      background: var(--accent-dim);
    }
    .run-title {
      font-family: 'Lora', Georgia, serif;
      font-size: 22px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .run-id-label {
      font-size: 12px;
      color: var(--text-tertiary);
      font-family: 'JetBrains Mono', monospace;
      margin-top: 2px;
    }

    /* ── Status Hero ── */
    .status-hero {
      border-radius: var(--radius-lg);
      padding: 20px 24px;
      margin-bottom: 16px;
      border: 1px solid;
      display: flex;
      align-items: flex-start;
      gap: 16px;
    }
    .status-hero.passed {
      background: var(--success-bg);
      border-color: var(--success-border);
    }
    .status-hero.failed {
      background: var(--failure-bg);
      border-color: var(--failure-border);
    }
    .status-hero-icon {
      width: 44px; height: 44px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
    }
    .status-hero.passed .status-hero-icon { background: var(--success-dim); color: var(--success); }
    .status-hero.failed .status-hero-icon { background: var(--failure-dim); color: var(--failure); }
    .status-hero-verdict {
      font-family: 'Lora', Georgia, serif;
      font-size: 20px;
      font-weight: 700;
      line-height: 1.1;
    }
    .status-hero.passed .status-hero-verdict { color: var(--success); }
    .status-hero.failed .status-hero-verdict { color: var(--failure); }
    .status-hero-reason {
      font-size: 14px;
      color: var(--text-secondary);
      margin-top: 6px;
      line-height: 1.5;
    }
    .status-hero-reason strong {
      color: var(--text-primary);
      font-weight: 600;
    }
    .status-hero-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 10px;
      font-size: 13px;
      color: var(--text-tertiary);
    }
    .status-hero-meta span {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .status-hero-meta strong { color: var(--text-secondary); font-weight: 500; }

    /* ── Phase Track ── */
    .phase-track {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
    }
    .phase-seg {
      flex: 1;
      padding: 10px 14px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid;
    }
    .phase-seg.passed { background: var(--success-bg); border-color: var(--success-border); }
    .phase-seg.failed { background: var(--failure-bg); border-color: var(--failure-border); }
    .phase-name {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
    }
    .phase-seg.passed .phase-name { color: var(--success); }
    .phase-seg.failed .phase-name { color: var(--failure); }
    .phase-steps {
      font-size: 11px;
      color: var(--text-tertiary);
      font-family: 'JetBrains Mono', monospace;
    }

    /* ── Workspace Layout ── */
    .workspace {
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 14px;
      min-height: 580px;
    }

    /* ── Timeline Panel ── */
    .timeline {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .timeline-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .timeline-header h3 {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .timeline-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 6px;
    }
    .timeline-scroll::-webkit-scrollbar { width: 4px; }
    .timeline-scroll::-webkit-scrollbar-track { background: transparent; }
    .timeline-scroll::-webkit-scrollbar-thumb { background: var(--border-emphasis); border-radius: 4px; }

    /* Phase divider in timeline */
    .phase-divider {
      padding: 10px 10px 5px;
      font-size: 10px;
      font-weight: 700;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .phase-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border);
    }

    /* Step item */
    .step-item {
      width: 100%;
      padding: 9px 10px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      cursor: pointer;
      transition: all 0.1s;
      font-family: inherit;
      font-size: inherit;
      color: inherit;
      text-align: left;
      display: block;
      margin-bottom: 1px;
    }
    .step-item:hover { background: var(--bg-hover); border-color: var(--border); }
    .step-item.selected { background: var(--bg-active); border-color: var(--accent-border); }
    .step-item.failed-step { background: var(--failure-bg); border-color: var(--failure-border); }
    .step-item.failed-step:hover { background: rgba(248,113,113,0.1); }
    .step-item.failed-step.selected { background: var(--failure-dim); border-color: var(--failure-border); }

    .step-item-row {
      display: flex;
      align-items: flex-start;
      gap: 9px;
    }
    .step-num {
      width: 24px; height: 24px;
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700;
      flex-shrink: 0;
      font-family: 'JetBrains Mono', monospace;
      margin-top: 1px;
    }
    .step-num.passed { background: var(--success-dim); color: var(--success); }
    .step-num.failed { background: var(--failure-dim); color: var(--failure); }
    .step-num.skipped { background: rgba(139,148,158,0.1); color: var(--text-tertiary); }

    .step-body { flex: 1; min-width: 0; }
    .step-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      line-height: 1.4;
      word-break: break-word;
      white-space: normal;
    }
    .step-item.failed-step .step-label { color: var(--failure); }
    .step-meta {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .step-time {
      font-size: 10px;
      color: var(--text-tertiary);
      font-family: 'JetBrains Mono', monospace;
      flex-shrink: 0;
      margin-top: 2px;
    }

    /* Inline error preview */
    .step-error-inline {
      margin-top: 5px;
      padding: 5px 8px;
      background: var(--failure-dim);
      border-radius: 5px;
      font-size: 11px;
      color: var(--failure);
      line-height: 1.4;
      word-break: break-word;
    }

    /* ── Detail Panel ── */
    .detail {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .detail-header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .detail-header h3 {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .detail-body {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 300px;
      overflow: hidden;
    }

    /* Screenshot area */
    .screenshot-area {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--bg-inset);
      position: relative;
    }

    .screenshot-toggle {
      display: flex;
      gap: 2px;
      padding: 3px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin-bottom: 16px;
    }
    .screenshot-toggle button {
      padding: 4px 12px;
      border: none;
      border-radius: 6px;
      font-family: 'Sora', sans-serif;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      background: transparent;
      color: var(--text-tertiary);
      letter-spacing: 0.02em;
    }
    .screenshot-toggle button.active { background: var(--accent-dim); color: var(--accent); }
    .screenshot-toggle button:hover:not(.active) { color: var(--text-secondary); }

    /* ── Device Frame ── */
    .device-frame { position: relative; flex-shrink: 0; }

    /* iOS device */
    .device-frame.ios {
      width: 280px;
      padding: 14px 10px;
      background: linear-gradient(145deg, #2c2c2e, #1c1c1e);
      border-radius: 40px;
      border: 2px solid rgba(255,255,255,0.1);
      box-shadow: 0 20px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05), inset 0 1px 0 rgba(255,255,255,0.1);
    }
    [data-theme="light"] .device-frame.ios {
      background: linear-gradient(145deg, #e8e8ed, #d1d1d6);
      border-color: rgba(0,0,0,0.08);
      box-shadow: 0 20px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.6);
    }
    .device-frame.ios .device-notch {
      position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
      width: 90px; height: 22px; background: #000; border-radius: 0 0 16px 16px; z-index: 5;
    }
    .device-frame.ios .device-home {
      width: 100px; height: 4px; background: rgba(255,255,255,0.3); border-radius: 3px; margin: 8px auto 0;
    }
    [data-theme="light"] .device-frame.ios .device-home { background: rgba(0,0,0,0.2); }

    /* Android device */
    .device-frame.android {
      width: 280px;
      background: linear-gradient(165deg, #2a2a2a 0%, #1a1a1a 30%, #111 100%);
      border-radius: 22px;
      border: 2px solid rgba(255,255,255,0.06);
      box-shadow: 0 25px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.8);
      overflow: hidden;
    }
    .device-frame.android .device-bezel-top {
      padding: 18px 0 14px; display: flex; align-items: center; justify-content: center; gap: 14px;
    }
    .device-frame.android .device-camera {
      width: 8px; height: 8px; background: radial-gradient(circle, #2a2a4a 40%, #1a1a2e 60%);
      border: 1.5px solid rgba(255,255,255,0.08); border-radius: 50%;
    }
    .device-frame.android .device-speaker {
      width: 60px; height: 5px; background: #0a0a0a; border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.04); box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
    }
    .device-frame.android .device-bezel-bottom {
      padding: 14px 0 16px; display: flex; align-items: center; justify-content: center;
    }
    .device-frame.android .nav-pill {
      width: 56px; height: 5px; background: #0a0a0a; border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.05); box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
    }
    .device-frame.android .device-screen { margin: 0 8px; }

    .screenshot-frame {
      width: 100%; border-radius: 8px; overflow: hidden; background: #000; position: relative; flex-shrink: 0;
    }
    .device-frame.ios .screenshot-frame { border-radius: 30px; }
    .device-frame.android .screenshot-frame { border-radius: 4px; }
    .screenshot-frame img { width: 100%; display: block; object-fit: contain; }
    .empty-screenshot {
      width: 260px; height: 400px; display: flex; align-items: center; justify-content: center;
      color: var(--text-tertiary); font-size: 13px; text-align: center; padding: 32px; line-height: 1.6;
    }

    /* Tap pointer overlay — uses box-shadow ripple to avoid GPU compositing layer issues
       that occur when transform:scale() is clipped by overflow:hidden on the parent */
    .tap-pointer {
      position: absolute; transform: translate(-50%, -50%);
      pointer-events: none; z-index: 10;
    }
    .tap-pointer-dot {
      width: 16px; height: 16px;
      background: #f87171; border: 2.5px solid #fff; border-radius: 50%;
      box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.5);
      animation: tap-pulse 1.6s ease-out infinite;
    }
    @keyframes tap-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.6); }
      60%  { box-shadow: 0 0 0 18px rgba(248, 113, 113, 0); }
      100% { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0); }
    }

    /* Step info sidebar */
    .step-info {
      padding: 18px;
      overflow-y: auto;
      border-left: 1px solid var(--border);
    }
    .step-info::-webkit-scrollbar { width: 4px; }
    .step-info::-webkit-scrollbar-track { background: transparent; }
    .step-info::-webkit-scrollbar-thumb { background: var(--border-emphasis); border-radius: 4px; }

    .info-section {
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .info-section:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
    .info-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.09em;
      margin-bottom: 5px;
    }
    .info-value {
      font-size: 13px;
      color: var(--text-primary);
      font-weight: 500;
      line-height: 1.55;
      word-break: break-word;
    }
    .info-value.error {
      color: var(--failure);
      background: var(--failure-bg);
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--failure-border);
      font-size: 12px;
    }
    .info-value.mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
    .info-value.command {
      padding: 9px 11px;
      background: var(--bg-inset);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      font-size: 13px;
      line-height: 1.55;
      font-style: italic;
      color: var(--text-primary);
    }
    .info-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 4px 10px;
      border-radius: 999px;
    }
    .info-status-badge.passed { background: var(--success-dim); color: var(--success); border: 1px solid var(--success-border); }
    .info-status-badge.failed { background: var(--failure-dim); color: var(--failure); border: 1px solid var(--failure-border); }
    .info-status-badge.skipped { background: var(--bg-elevated); color: var(--text-tertiary); border: 1px solid var(--border); }

    @media (max-width: 1100px) {
      .workspace { grid-template-columns: 1fr; }
      .detail-body { grid-template-columns: 1fr; }
      .step-info { border-left: none; border-top: 1px solid var(--border); }
      .device-frame.ios, .device-frame.android { width: 240px; }
    }
    @media (max-width: 768px) {
      .workspace { grid-template-columns: 1fr; }
      .page { padding: 16px 16px 48px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <!-- Header -->
    <header class="run-header animate-in">
      <div class="run-header-left">
        <a class="back-btn" href="/" title="All runs">${iconArrowLeft()}</a>
        <div style="min-width:0">
          <h1 class="run-title">${escapeHtml(name)}</h1>
          <div class="run-id-label">${escapeHtml(formatDate(manifest.startedAt))}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        <div class="theme-toggle" id="theme-toggle">
          <button id="theme-light" onclick="setTheme('light')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            Light
          </button>
          <button id="theme-dark" onclick="setTheme('dark')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            Dark
          </button>
        </div>
      </div>
    </header>

    <!-- Status Hero -->
    ${(() => {
      const failedStep = manifest.steps.find((s) => s.status === 'failed');
      const verdictText = manifest.success
        ? 'Flow passed'
        : `Flow failed at step ${manifest.stepsExecuted} of ${manifest.stepsTotal}`;
      const cls = manifest.success ? 'passed' : 'failed';
      const icon = manifest.success
        ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

      let reasonHtml = '';
      if (!manifest.success) {
        if (failedStep?.verbatim) {
          reasonHtml = `<div class="status-hero-reason"><strong>"${escapeHtml(failedStep.verbatim)}"</strong></div>`;
        }
        if (manifest.reason) {
          reasonHtml += `<div class="status-hero-reason">${escapeHtml(manifest.reason)}</div>`;
        } else if (failedStep?.error) {
          reasonHtml += `<div class="status-hero-reason">${escapeHtml(failedStep.error)}</div>`;
        }
      }

      return `<section class="status-hero ${cls} animate-in animate-in-1">
        <div class="status-hero-icon">${icon}</div>
        <div style="min-width:0">
          <div class="status-hero-verdict">${escapeHtml(verdictText)}</div>
          ${reasonHtml}
          <div class="status-hero-meta">
            <span>${platformIcon} <strong>${escapeHtml(manifest.platform)}</strong></span>
            <span>${iconClock()} <strong>${escapeHtml(formatDuration(manifest.durationMs))}</strong></span>
            <span>${iconSteps()} <strong>${manifest.stepsExecuted}/${manifest.stepsTotal}</strong> steps</span>
            ${manifest.device ? `<span>${iconDevice()} <strong>${escapeHtml(manifest.device)}</strong></span>` : ''}
          </div>
        </div>
      </section>`;
    })()}

    ${hasPhases ? renderPhaseTrack(manifest) : ''}

    <!-- Workspace -->
    <section class="workspace animate-in animate-in-2">
      <!-- Timeline -->
      <div class="timeline">
        <div class="timeline-header">
          <h3>Steps</h3>
          <span style="font-size:11px;color:var(--text-tertiary);font-family:'JetBrains Mono',monospace">${manifest.steps.length}</span>
        </div>
        <div class="timeline-scroll">
          ${renderStepTimeline(manifest)}
        </div>
      </div>

      <!-- Detail Panel -->
      <div class="detail">
        <div class="detail-header">
          <h3>Step Inspector</h3>
          <div class="screenshot-toggle" id="screenshot-toggle" style="display:none"></div>
        </div>
        <div class="detail-body">
          <div class="screenshot-area" id="screenshot-area">
            ${
              manifest.steps.length > 0 && manifest.steps[0].screenshotPath
                ? `<div class="device-frame ${escapeHtml(manifest.platform)}" id="device-frame">
                  ${
                    manifest.platform === 'ios'
                      ? '<div class="device-notch"></div>'
                      : '<div class="device-bezel-top"><div class="device-camera"></div><div class="device-speaker"></div></div>'
                  }
                  <div class="${manifest.platform === 'android' ? 'device-screen' : ''}"><div class="screenshot-frame" id="screenshot-frame"><img id="screenshot-img" src="/artifacts/${escapeHtml(manifest.runId)}/${escapeHtml(manifest.steps[0].screenshotPath)}" alt="Step screenshot"></div></div>
                  ${
                    manifest.platform === 'ios'
                      ? '<div class="device-home"></div>'
                      : '<div class="device-bezel-bottom"><div class="nav-pill"></div></div>'
                  }
                </div>`
                : `<div class="empty-screenshot" id="screenshot-frame">Select a step to view its screenshot</div>`
            }
          </div>
          <div class="step-info" id="step-info">
            ${manifest.steps.length > 0 ? renderStepDetailInfo(manifest.steps[0]) : ''}
          </div>
        </div>
      </div>
    </section>
  </main>

  <script>
    var steps = ${JSON.stringify(
      manifest.steps.map((s) => ({
        index: s.index,
        kind: s.kind,
        verbatim: s.verbatim || null,
        target: s.target || null,
        phase: s.phase,
        status: s.status,
        durationMs: s.durationMs,
        error: s.error || null,
        message: s.message || null,
        screenshotPath: s.screenshotPath || null,
        beforeScreenshotPath: s.beforeScreenshotPath || null,
        tapCoordinates: s.tapCoordinates || null,
        deviceScreenSize: s.deviceScreenSize || null,
        screenshotSize: s.screenshotSize || null,
      }))
    ).replace(/</g, '\\u003c')};
    var runId = ${JSON.stringify(manifest.runId).replace(/</g, '\\u003c')};
    var platform = ${JSON.stringify(manifest.platform).replace(/</g, '\\u003c')};
    var currentStep = null;
    var currentView = 'before';

    function selectStep(index) {
      document.querySelectorAll('.step-item').forEach(function(el) { el.classList.remove('selected'); });
      var btn = document.querySelector('[data-step="' + index + '"]');
      if (btn) btn.classList.add('selected');

      var step = steps.find(function(s) { return s.index === index; });
      if (!step) return;
      currentStep = step;

      var hasBefore = step.beforeScreenshotPath && step.tapCoordinates;
      currentView = hasBefore ? 'before' : 'after';

      renderScreenshot();
      renderInfo();
    }

    function renderScreenshot() {
      var step = currentStep;
      if (!step) return;

      var area = document.getElementById('screenshot-area');
      var toggle = document.getElementById('screenshot-toggle');
      var hasBefore = step.beforeScreenshotPath && step.tapCoordinates;

      if (hasBefore && step.screenshotPath) {
        toggle.style.display = 'flex';
        toggle.innerHTML =
          '<button class="' + (currentView === 'before' ? 'active' : '') + '" onclick="switchView(\\'before\\')">Tap Location</button>' +
          '<button class="' + (currentView === 'after' ? 'active' : '') + '" onclick="switchView(\\'after\\')">After</button>';
      } else {
        toggle.style.display = 'none';
      }

      var imgPath = null;
      var showPointer = false;

      if (currentView === 'before' && hasBefore) {
        imgPath = step.beforeScreenshotPath;
        showPointer = true;
      } else if (step.screenshotPath) {
        imgPath = step.screenshotPath;
      }

      if (imgPath) {
        var deviceTop = platform === 'ios'
          ? '<div class="device-notch"></div>'
          : '<div class="device-bezel-top"><div class="device-camera"></div><div class="device-speaker"></div></div>';
        var deviceBottom = platform === 'ios'
          ? '<div class="device-home"></div>'
          : '<div class="device-bezel-bottom"><div class="nav-pill"></div></div>';
        var screenWrapOpen = platform === 'android' ? '<div class="device-screen">' : '';
        var screenWrapClose = platform === 'android' ? '</div>' : '';

        area.innerHTML =
          '<div class="device-frame ' + platform + '" id="device-frame">' +
            deviceTop +
            screenWrapOpen +
            '<div class="screenshot-frame" id="screenshot-frame">' +
              '<img id="screenshot-img" src="/artifacts/' + runId + '/' + imgPath + '" alt="Step screenshot">' +
            '</div>' +
            screenWrapClose +
            deviceBottom +
          '</div>';

        var frame = document.getElementById('screenshot-frame');
        if (showPointer && step.tapCoordinates) {
          var img = document.getElementById('screenshot-img');
          var addPointer = function() {
            var old = frame.querySelector('.tap-pointer');
            if (old) old.remove();

            // Tap coordinates are always in deviceScreenSize space (Appium's coordinate
            // system). Screenshots may be downscaled (e.g. 720x1560 vs device 1440x3120)
            // so screenshotSize (PNG dims) must not be used for coordinate mapping.
            var coordW, coordH;
            if (step.deviceScreenSize) {
              coordW = step.deviceScreenSize.width;
              coordH = step.deviceScreenSize.height;
            } else {
              coordW = img.naturalWidth || 360;
              coordH = img.naturalHeight || 800;
            }

            var pctX = Math.min(100, Math.max(0, (step.tapCoordinates.x / coordW) * 100));
            var pctY = Math.min(100, Math.max(0, (step.tapCoordinates.y / coordH) * 100));

            var pointer = document.createElement('div');
            pointer.className = 'tap-pointer';
            pointer.style.left = pctX + '%';
            pointer.style.top = pctY + '%';
            pointer.innerHTML = '<div class="tap-pointer-dot"></div>';
            frame.appendChild(pointer);
          };
          if (img.complete) { addPointer(); }
          else { img.onload = addPointer; }
        }
      } else {
        area.innerHTML = '<div class="empty-screenshot" id="screenshot-frame">No screenshot for this step</div>';
      }
    }

    function switchView(view) {
      currentView = view;
      renderScreenshot();
    }

    function renderInfo() {
      var step = currentStep;
      if (!step) return;
      var el = document.getElementById('step-info');
      var html = '';

      if (step.verbatim) {
        html += '<div class="info-section"><div class="info-label">Instruction</div><div class="info-value command">' + esc(step.verbatim) + '</div></div>';
      } else if (step.target) {
        html += '<div class="info-section"><div class="info-label">Target</div><div class="info-value command">' + esc(step.target) + '</div></div>';
      }
      html += '<div class="info-section"><div class="info-label">Status</div><div class="info-status-badge ' + step.status + '">' + step.status + '</div></div>';
      html += '<div class="info-section"><div class="info-label">Action</div><div class="info-value">' + kindLabel(step.kind) + '</div></div>';
      html += '<div class="info-section"><div class="info-label">Phase</div><div class="info-value">' + step.phase + '</div></div>';
      html += '<div class="info-section"><div class="info-label">Duration</div><div class="info-value mono">' + fmtMs(step.durationMs) + '</div></div>';
      if (step.error) {
        html += '<div class="info-section"><div class="info-label">Error</div><div class="info-value error">' + esc(step.error) + '</div></div>';
      }
      if (step.message && step.message !== step.error) {
        html += '<div class="info-section"><div class="info-label">Message</div><div class="info-value">' + esc(step.message) + '</div></div>';
      }
      el.innerHTML = html;
    }

    function esc(str) {
      if (!str) return '';
      var d = document.createElement('div');
      d.appendChild(document.createTextNode(str));
      return d.innerHTML;
    }

    function fmtMs(ms) {
      if (ms < 1000) return ms + 'ms';
      return (ms / 1000).toFixed(1) + 's';
    }

    function kindLabel(kind) {
      var map = {tap:'Tap',type:'Type',assert:'Assert',scrollAssert:'Scroll Assert',swipe:'Swipe',wait:'Wait',waitUntil:'Wait Until',openApp:'Launch',launchApp:'Launch',back:'Back',home:'Home',enter:'Enter',getInfo:'Get Info',done:'Done'};
      return map[kind] || kind;
    }

    // Auto-select first step
    if (steps.length > 0) {
      window.addEventListener('DOMContentLoaded', function() { selectStep(steps[0].index); });
    }
  </script>
  ${themeScript()}
</body>
</html>`;
}

function renderPhaseTrack(manifest: RunManifest): string {
  if (!manifest.phaseResults) return '';
  return `
    <section class="phase-track animate-in animate-in-2">
      ${manifest.phaseResults
        .map((pr) => {
          const cls = pr.success ? 'passed' : 'failed';
          return `
          <div class="phase-seg ${cls}">
            <span class="phase-name">${phaseLabel(pr.phase)}</span>
            <span class="phase-steps">${pr.stepsExecuted}/${pr.stepsTotal}</span>
          </div>`;
        })
        .join('')}
    </section>`;
}

function renderStepTimeline(manifest: RunManifest): string {
  const hasPhases = manifest.phaseResults && manifest.phaseResults.length > 0;
  let html = '';
  let currentPhase: FlowPhase | null = null;

  for (const step of manifest.steps) {
    if (hasPhases && step.phase !== currentPhase) {
      currentPhase = step.phase;
      html += `<div class="phase-divider">${phaseLabel(step.phase)}</div>`;
    }
    html += renderStepItem(step);
  }

  if (manifest.steps.length === 0) {
    html = '<div class="empty-screenshot">No steps recorded</div>';
  }

  return html;
}

function renderStepItem(step: StepArtifact): string {
  const isFirst = step.index === 0;
  const label = step.verbatim || step.target || step.kind;
  const failedCls = step.status === 'failed' ? ' failed-step' : '';
  return `
    <button
      class="step-item${isFirst ? ' selected' : ''}${failedCls}"
      data-step="${step.index}"
      onclick="selectStep(${step.index})"
      type="button"
    >
      <div class="step-item-row">
        <span class="step-num ${step.status}">${step.index + 1}</span>
        <div class="step-body">
          <div class="step-label">${escapeHtml(label)}</div>
          <div class="step-meta">
            <span>${escapeHtml(stepKindLabel(step.kind))}</span>
          </div>
        </div>
        <span class="step-time">${escapeHtml(formatDuration(step.durationMs))}</span>
      </div>
      ${step.status === 'failed' && step.error ? `<div class="step-error-inline">${escapeHtml(step.error)}</div>` : ''}
    </button>`;
}

function renderStepDetailInfo(step: StepArtifact): string {
  let html = '';
  if (step.verbatim) {
    html += `<div class="info-section"><div class="info-label">Instruction</div><div class="info-value command">${escapeHtml(step.verbatim)}</div></div>`;
  } else if (step.target) {
    html += `<div class="info-section"><div class="info-label">Target</div><div class="info-value command">${escapeHtml(step.target)}</div></div>`;
  }
  html += `<div class="info-section"><div class="info-label">Status</div><div class="info-status-badge ${step.status}">${escapeHtml(step.status)}</div></div>`;
  html += `<div class="info-section"><div class="info-label">Action</div><div class="info-value">${escapeHtml(stepKindLabel(step.kind))}</div></div>`;
  html += `<div class="info-section"><div class="info-label">Phase</div><div class="info-value">${escapeHtml(step.phase)}</div></div>`;
  html += `<div class="info-section"><div class="info-label">Duration</div><div class="info-value mono">${escapeHtml(formatDuration(step.durationMs))}</div></div>`;
  if (step.error) {
    html += `<div class="info-section"><div class="info-label">Error</div><div class="info-value error">${escapeHtml(step.error)}</div></div>`;
  }
  if (step.message && step.message !== step.error) {
    html += `<div class="info-section"><div class="info-label">Message</div><div class="info-value">${escapeHtml(step.message)}</div></div>`;
  }
  return html;
}
