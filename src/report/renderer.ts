/**
 * HTML renderer — server-side rendered pages for AppClaw flow execution reports.
 *
 * Produces complete HTML strings with embedded CSS and JS.
 * No build step required — pure template strings.
 */

import type { RunIndex, RunIndexEntry, RunManifest, StepArtifact } from "./types.js";
import type { FlowPhase } from "../flow/types.js";

/* ─── Helpers ────────────────────────────────────────────── */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function successRate(runs: RunIndexEntry[]): number {
  if (runs.length === 0) return 0;
  return (runs.filter((r) => r.success).length / runs.length) * 100;
}

function totalDuration(runs: RunIndexEntry[]): number {
  return runs.reduce((sum, r) => sum + r.durationMs, 0);
}

function phaseLabel(phase: FlowPhase): string {
  switch (phase) {
    case "setup": return "Setup";
    case "test": return "Test";
    case "assertion": return "Assertion";
  }
}

function stepKindIcon(kind: string): string {
  switch (kind) {
    case "tap": return "👆";
    case "type": return "⌨";
    case "assert": case "scrollAssert": return "✓";
    case "swipe": return "↕";
    case "wait": case "waitUntil": return "⏳";
    case "openApp": case "launchApp": return "🚀";
    case "back": case "home": return "◀";
    case "enter": return "⏎";
    case "getInfo": return "ℹ";
    case "done": return "✦";
    default: return "•";
  }
}

function stepKindLabel(kind: string): string {
  switch (kind) {
    case "tap": return "Tap";
    case "type": return "Type";
    case "assert": return "Assert";
    case "scrollAssert": return "Scroll Assert";
    case "swipe": return "Swipe";
    case "wait": return "Wait";
    case "waitUntil": return "Wait Until";
    case "openApp": case "launchApp": return "Launch";
    case "back": return "Back";
    case "home": return "Home";
    case "enter": return "Enter";
    case "getInfo": return "Get Info";
    case "done": return "Done";
    default: return kind;
  }
}

/* ─── Font ───────────────────────────────────────────────── */

function fontLinks(): string {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;
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
      --bg-root: #06080d;
      --bg-surface: #0d1117;
      --bg-elevated: #161b22;
      --bg-inset: #0a0e14;
      --bg-hover: rgba(56, 189, 248, 0.04);
      --bg-active: rgba(56, 189, 248, 0.08);

      --accent: #38bdf8;
      --accent-dim: rgba(56, 189, 248, 0.15);
      --accent-border: rgba(56, 189, 248, 0.25);
      --accent-glow: rgba(56, 189, 248, 0.12);

      --success: #22c55e;
      --success-dim: rgba(34, 197, 94, 0.12);
      --success-border: rgba(34, 197, 94, 0.25);
      --failure: #f87171;
      --failure-dim: rgba(248, 113, 113, 0.12);
      --failure-border: rgba(248, 113, 113, 0.25);
      --warning: #fbbf24;
      --warning-dim: rgba(251, 191, 36, 0.12);

      --text-primary: #e2e8f0;
      --text-secondary: #8b949e;
      --text-tertiary: #545d68;

      --border: rgba(240, 246, 252, 0.08);
      --border-emphasis: rgba(240, 246, 252, 0.15);

      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --radius-xl: 20px;

      --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
      --shadow-md: 0 4px 16px rgba(0,0,0,0.3);
      --shadow-lg: 0 8px 32px rgba(0,0,0,0.4);
      --shadow-glow: 0 0 40px var(--accent-glow);

      --brand-mark-bg: linear-gradient(135deg, #38bdf8, #818cf8);
      --brand-mark-color: #06080d;
      --screenshot-border: rgba(255,255,255,0.06);
      --screenshot-shadow-inner: rgba(255,255,255,0.03);
    }

    [data-theme="light"] {
      --bg-root: #f8fafc;
      --bg-surface: #ffffff;
      --bg-elevated: #f1f5f9;
      --bg-inset: #e2e8f0;
      --bg-hover: rgba(56, 189, 248, 0.06);
      --bg-active: rgba(56, 189, 248, 0.1);

      --accent: #0284c7;
      --accent-dim: rgba(2, 132, 199, 0.1);
      --accent-border: rgba(2, 132, 199, 0.25);
      --accent-glow: rgba(2, 132, 199, 0.08);

      --success: #16a34a;
      --success-dim: rgba(22, 163, 74, 0.1);
      --success-border: rgba(22, 163, 74, 0.25);
      --failure: #dc2626;
      --failure-dim: rgba(220, 38, 38, 0.08);
      --failure-border: rgba(220, 38, 38, 0.25);
      --warning: #d97706;
      --warning-dim: rgba(217, 119, 6, 0.1);

      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-tertiary: #94a3b8;

      --border: rgba(15, 23, 42, 0.08);
      --border-emphasis: rgba(15, 23, 42, 0.15);

      --shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
      --shadow-md: 0 4px 16px rgba(0,0,0,0.08);
      --shadow-lg: 0 8px 32px rgba(0,0,0,0.1);
      --shadow-glow: 0 0 40px var(--accent-glow);

      --brand-mark-bg: linear-gradient(135deg, #0284c7, #6366f1);
      --brand-mark-color: #ffffff;
      --screenshot-border: rgba(0,0,0,0.1);
      --screenshot-shadow-inner: rgba(0,0,0,0.05);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg-root);
      color: var(--text-primary);
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 15px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      transition: background 0.3s, color 0.3s;
    }

    .page {
      max-width: 1400px;
      margin: 0 auto;
      padding: 28px 32px 56px;
    }

    a { color: var(--accent); text-decoration: none; transition: opacity 0.15s; }
    a:hover { opacity: 0.85; }

    /* ── Animations ── */
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideInLeft {
      from { opacity: 0; transform: translateX(-8px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes pulseGlow {
      0%, 100% { box-shadow: 0 0 8px var(--accent-glow); }
      50% { box-shadow: 0 0 20px var(--accent-glow); }
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    .animate-in {
      animation: fadeInUp 0.4s ease-out both;
    }
    .animate-in-1 { animation-delay: 0.05s; }
    .animate-in-2 { animation-delay: 0.1s; }
    .animate-in-3 { animation-delay: 0.15s; }
    .animate-in-4 { animation-delay: 0.2s; }
    .animate-in-5 { animation-delay: 0.25s; }

    /* ── Status Pill ── */
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
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
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .status-dot.success { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .status-dot.failure { background: var(--failure); box-shadow: 0 0 6px var(--failure); }

    /* ── Brand ── */
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--text-primary);
    }
    .brand-mark {
      width: 36px; height: 36px;
      border-radius: 10px;
      background: var(--brand-mark-bg);
      display: flex; align-items: center; justify-content: center;
      font-size: 17px; font-weight: 800; color: var(--brand-mark-color);
      box-shadow: 0 0 20px var(--accent-glow);
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
      padding: 6px 10px;
      border: none;
      border-radius: 6px;
      font-family: 'Outfit', sans-serif;
      font-size: 13px;
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
    .theme-toggle button:hover:not(.active) {
      color: var(--text-secondary);
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  `;
}

/* ─── SVG Icons ──────────────────────────────────────────── */

function iconRuns(): string {
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
}
function iconCheck(): string {
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
}
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

/* ─── Run Index Page ─────────────────────────────────────── */

export function renderIndexPage(index: RunIndex): string {
  const runs = index.runs;
  const rate = successRate(runs);
  const failed = runs.filter(r => !r.success).length;

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
      margin-bottom: 28px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }
    .page-header .subtitle {
      color: var(--text-secondary);
      font-size: 15px;
      margin-top: 6px;
      font-weight: 400;
    }

    /* ── Stat Cards ── */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 28px;
    }
    .stat-card {
      padding: 20px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      display: flex;
      align-items: center;
      gap: 16px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .stat-card:hover {
      border-color: var(--border-emphasis);
      box-shadow: var(--shadow-md);
    }
    .stat-icon {
      width: 44px; height: 44px;
      border-radius: var(--radius-md);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .stat-icon.accent { background: var(--accent-dim); color: var(--accent); }
    .stat-icon.success { background: var(--success-dim); color: var(--success); }
    .stat-icon.failure { background: var(--failure-dim); color: var(--failure); }
    .stat-icon.neutral { background: rgba(139,148,158,0.1); color: var(--text-secondary); }
    .stat-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 4px;
    }
    .stat-value {
      font-size: 30px;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--text-primary);
    }
    .stat-value.success { color: var(--success); }
    .stat-value.failure { color: var(--failure); }

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
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
    }
    .runs-header h2 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .runs-count {
      font-size: 13px;
      color: var(--text-tertiary);
      padding: 4px 10px;
      background: var(--bg-elevated);
      border-radius: 999px;
      font-weight: 500;
    }

    .run-item {
      display: grid;
      grid-template-columns: 8px 1fr 100px 120px 90px 80px 90px;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background 0.15s;
      text-decoration: none;
      color: inherit;
    }
    .run-item:hover {
      background: var(--bg-hover);
      opacity: 1;
    }
    .run-item:last-child { border-bottom: none; }

    .run-status-bar {
      width: 4px;
      height: 36px;
      border-radius: 4px;
    }
    .run-status-bar.success { background: var(--success); box-shadow: 0 0 8px var(--success-dim); }
    .run-status-bar.failure { background: var(--failure); box-shadow: 0 0 8px var(--failure-dim); }

    .run-name {
      font-weight: 600;
      font-size: 15px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .run-file {
      font-size: 13px;
      color: var(--text-tertiary);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .run-platform {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      padding: 4px 10px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      width: fit-content;
    }

    .run-date {
      font-size: 14px;
      color: var(--text-secondary);
    }
    .run-duration {
      font-size: 14px;
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }
    .run-steps {
      font-size: 14px;
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }

    .empty-state {
      padding: 64px 32px;
      text-align: center;
      color: var(--text-tertiary);
    }
    .empty-state p { font-size: 15px; margin-bottom: 8px; }
    .empty-state code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      padding: 3px 8px;
      background: var(--bg-elevated);
      border-radius: 6px;
      color: var(--accent);
    }

    /* ── Column Headers ── */
    .run-list-header {
      display: grid;
      grid-template-columns: 8px 1fr 100px 120px 90px 80px 90px;
      gap: 16px;
      padding: 10px 24px;
      background: var(--bg-inset);
      border-bottom: 1px solid var(--border);
    }
    .col-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    @media (max-width: 900px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .run-item, .run-list-header {
        grid-template-columns: 4px 1fr auto auto;
      }
      .run-date, .run-steps, .run-duration { display: none; }
    }
    @media (max-width: 600px) {
      .stats-row { grid-template-columns: 1fr; }
      .page { padding: 16px; }
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
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          Light
        </button>
        <button id="theme-dark" onclick="setTheme('dark')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          Dark
        </button>
      </div>
    </header>

    <!-- Stats -->
    <section class="stats-row">
      <div class="stat-card animate-in animate-in-1">
        <div class="stat-icon accent">${iconRuns()}</div>
        <div>
          <div class="stat-label">Total Runs</div>
          <div class="stat-value">${runs.length}</div>
        </div>
      </div>
      <div class="stat-card animate-in animate-in-2">
        <div class="stat-icon success">${iconCheck()}</div>
        <div>
          <div class="stat-label">Pass Rate</div>
          <div class="stat-value ${rate >= 80 ? "success" : rate >= 50 ? "" : "failure"}">${rate.toFixed(0)}%</div>
        </div>
      </div>
      <div class="stat-card animate-in animate-in-3">
        <div class="stat-icon failure">${iconSteps()}</div>
        <div>
          <div class="stat-label">Failed</div>
          <div class="stat-value failure">${failed}</div>
        </div>
      </div>
      <div class="stat-card animate-in animate-in-4">
        <div class="stat-icon neutral">${iconClock()}</div>
        <div>
          <div class="stat-label">Total Time</div>
          <div class="stat-value">${escapeHtml(formatDuration(totalDuration(runs)))}</div>
        </div>
      </div>
    </section>

    <!-- Run List -->
    <section class="runs-panel animate-in animate-in-5">
      <div class="runs-header">
        <h2>Run History</h2>
        <span class="runs-count">${runs.length} run${runs.length !== 1 ? "s" : ""}</span>
      </div>
      ${runs.length === 0
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
            <span class="col-label">Steps</span>
            <span class="col-label">Status</span>
          </div>
          ${runs.map(renderRunRow).join("")}`}
    </section>
  </main>
  ${themeScript()}
</body>
</html>`;
}

function renderRunRow(run: RunIndexEntry): string {
  const name = run.flowName || run.flowFile.split("/").pop() || run.runId;
  const cls = run.success ? "success" : "failure";
  const platformIcon = run.platform === "ios" ? iconApple() : iconAndroid();
  return `
    <a class="run-item" href="/runs/${escapeHtml(run.runId)}">
      <div class="run-status-bar ${cls}"></div>
      <div>
        <div class="run-name">${escapeHtml(name)}</div>
        <div class="run-file">${escapeHtml(run.flowFile)}</div>
      </div>
      <span class="run-platform">${platformIcon} ${escapeHtml(run.platform)}</span>
      <span class="run-date">${escapeHtml(formatDateShort(run.startedAt))}</span>
      <span class="run-duration">${escapeHtml(formatDuration(run.durationMs))}</span>
      <span class="run-steps">${run.stepsExecuted}/${run.stepsTotal}</span>
      ${renderStatusPill(run.success)}
    </a>`;
}

function renderStatusPill(success: boolean): string {
  const cls = success ? "success" : "failure";
  const label = success ? "Passed" : "Failed";
  return `<span class="status-pill ${cls}"><span class="status-dot ${cls}"></span>${label}</span>`;
}

/* ─── Run Detail Page ────────────────────────────────────── */

export function renderRunPage(manifest: RunManifest): string {
  const name = manifest.meta.name || manifest.flowFile.split("/").pop() || manifest.runId;
  const hasPhases = manifest.phaseResults && manifest.phaseResults.length > 0;
  const platformIcon = manifest.platform === "ios" ? iconApple() : iconAndroid();

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
      align-items: flex-start;
      gap: 20px;
      margin-bottom: 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }
    .run-header-left {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      min-width: 0;
    }
    .back-btn {
      width: 38px; height: 38px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--radius-md);
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      transition: all 0.15s;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .back-btn:hover {
      border-color: var(--accent-border);
      color: var(--accent);
      background: var(--accent-dim);
    }
    .run-title {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.2;
    }
    .run-subtitle {
      color: var(--text-tertiary);
      font-size: 14px;
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .run-subtitle .sep { color: var(--text-tertiary); opacity: 0.4; }

    /* ── Meta Strip ── */
    .meta-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 20px;
    }
    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      font-size: 14px;
      color: var(--text-secondary);
      transition: border-color 0.15s;
    }
    .meta-chip:hover { border-color: var(--border-emphasis); }
    .meta-chip strong {
      color: var(--text-primary);
      font-weight: 600;
    }
    .meta-chip .icon {
      display: flex;
      color: var(--text-tertiary);
    }

    /* ── Phase Progress ── */
    .phase-track {
      display: flex;
      gap: 3px;
      margin-bottom: 20px;
      padding: 3px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
    }
    .phase-seg {
      flex: 1;
      padding: 12px 16px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      transition: all 0.2s;
    }
    .phase-seg.passed { background: var(--success-dim); }
    .phase-seg.failed { background: var(--failure-dim); }
    .phase-name {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .phase-seg.passed .phase-name { color: var(--success); }
    .phase-seg.failed .phase-name { color: var(--failure); }
    .phase-steps {
      font-size: 11px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

    /* ── Failure Banner ── */
    .failure-banner {
      padding: 16px 20px;
      background: var(--failure-dim);
      border: 1px solid var(--failure-border);
      border-radius: var(--radius-lg);
      margin-bottom: 20px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .failure-banner-icon {
      width: 24px; height: 24px;
      border-radius: 50%;
      background: var(--failure);
      color: var(--bg-root);
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 14px; flex-shrink: 0;
      margin-top: 1px;
    }
    .failure-banner h3 {
      font-size: 14px;
      font-weight: 600;
      color: var(--failure);
      margin-bottom: 4px;
    }
    .failure-banner p {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    /* ── Workspace Layout ── */
    .workspace {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 16px;
      min-height: 600px;
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
      padding: 16px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .timeline-header h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .timeline-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .timeline-scroll::-webkit-scrollbar { width: 5px; }
    .timeline-scroll::-webkit-scrollbar-track { background: transparent; }
    .timeline-scroll::-webkit-scrollbar-thumb { background: var(--border-emphasis); border-radius: 4px; }

    /* Phase divider in timeline */
    .phase-divider {
      padding: 10px 12px 6px;
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
      padding: 10px 12px;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: transparent;
      cursor: pointer;
      transition: all 0.12s;
      font-family: inherit;
      font-size: inherit;
      color: inherit;
      text-align: left;
      display: block;
      margin-bottom: 2px;
    }
    .step-item:hover {
      background: var(--bg-hover);
      border-color: var(--border);
    }
    .step-item.selected {
      background: var(--bg-active);
      border-color: var(--accent-border);
    }
    .step-item-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .step-num {
      width: 26px; height: 26px;
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700;
      flex-shrink: 0;
      font-family: 'JetBrains Mono', monospace;
    }
    .step-num.passed { background: var(--success-dim); color: var(--success); }
    .step-num.failed { background: var(--failure-dim); color: var(--failure); }
    .step-num.skipped { background: rgba(139,148,158,0.1); color: var(--text-tertiary); }

    .step-body { flex: 1; min-width: 0; }
    .step-label {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    .step-meta {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 1px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .step-time {
      font-size: 11px;
      color: var(--text-tertiary);
      font-family: 'JetBrains Mono', monospace;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }

    /* Inline error preview */
    .step-error-inline {
      margin-top: 6px;
      padding: 6px 8px;
      background: var(--failure-dim);
      border-radius: 6px;
      font-size: 11px;
      color: var(--failure);
      line-height: 1.4;
      max-height: 40px;
      overflow: hidden;
      text-overflow: ellipsis;
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
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .detail-header h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .detail-body {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 280px;
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
      padding: 5px 14px;
      border: none;
      border-radius: 6px;
      font-family: 'Outfit', sans-serif;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      background: transparent;
      color: var(--text-tertiary);
      letter-spacing: 0.02em;
    }
    .screenshot-toggle button.active {
      background: var(--accent-dim);
      color: var(--accent);
    }
    .screenshot-toggle button:hover:not(.active) {
      color: var(--text-secondary);
    }

    /* ── Device Frame ── */
    .device-frame {
      position: relative;
      flex-shrink: 0;
    }

    /* iOS device */
    .device-frame.ios {
      width: 280px;
      padding: 14px 10px;
      background: linear-gradient(145deg, #2c2c2e, #1c1c1e);
      border-radius: 40px;
      border: 2px solid rgba(255,255,255,0.1);
      box-shadow:
        0 20px 60px rgba(0,0,0,0.4),
        0 0 0 1px rgba(255,255,255,0.05),
        inset 0 1px 0 rgba(255,255,255,0.1);
    }
    [data-theme="light"] .device-frame.ios {
      background: linear-gradient(145deg, #e8e8ed, #d1d1d6);
      border-color: rgba(0,0,0,0.08);
      box-shadow:
        0 20px 60px rgba(0,0,0,0.15),
        0 0 0 1px rgba(0,0,0,0.05),
        inset 0 1px 0 rgba(255,255,255,0.6);
    }
    .device-frame.ios .device-notch {
      position: absolute;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      width: 90px;
      height: 22px;
      background: #000;
      border-radius: 0 0 16px 16px;
      z-index: 5;
    }
    .device-frame.ios .device-home {
      width: 100px;
      height: 4px;
      background: rgba(255,255,255,0.3);
      border-radius: 3px;
      margin: 8px auto 0;
    }
    [data-theme="light"] .device-frame.ios .device-home {
      background: rgba(0,0,0,0.2);
    }

    /* Android device — Nexus 6P style */
    .device-frame.android {
      width: 280px;
      background: linear-gradient(165deg, #2a2a2a 0%, #1a1a1a 30%, #111 100%);
      border-radius: 22px;
      border: 2px solid rgba(255,255,255,0.06);
      box-shadow:
        0 25px 60px rgba(0,0,0,0.5),
        0 0 0 1px rgba(0,0,0,0.8),
        4px 0 8px -2px rgba(0,0,0,0.3),
        -4px 0 8px -2px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    /* Top bezel */
    .device-frame.android .device-bezel-top {
      padding: 18px 0 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      position: relative;
    }
    .device-frame.android .device-camera {
      width: 8px;
      height: 8px;
      background: radial-gradient(circle, #2a2a4a 40%, #1a1a2e 60%);
      border: 1.5px solid rgba(255,255,255,0.08);
      border-radius: 50%;
      box-shadow: 0 0 3px rgba(100,100,200,0.15);
    }
    .device-frame.android .device-speaker {
      width: 60px;
      height: 5px;
      background: #0a0a0a;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.04);
      box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
    }
    /* Bottom bezel */
    .device-frame.android .device-bezel-bottom {
      padding: 14px 0 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .device-frame.android .nav-pill {
      width: 56px;
      height: 5px;
      background: #0a0a0a;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.05);
      box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
    }
    /* Screen inset */
    .device-frame.android .device-screen {
      margin: 0 8px;
    }

    .screenshot-frame {
      width: 100%;
      border-radius: 8px;
      overflow: hidden;
      background: #000;
      position: relative;
      flex-shrink: 0;
    }
    .device-frame.ios .screenshot-frame {
      border-radius: 30px;
    }
    .device-frame.android .screenshot-frame {
      border-radius: 4px;
    }
    .screenshot-frame img {
      width: 100%;
      display: block;
      object-fit: contain;
    }
    .empty-screenshot {
      width: 260px;
      height: 400px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-tertiary);
      font-size: 13px;
      text-align: center;
      padding: 32px;
      line-height: 1.6;
    }

    /* Tap pointer overlay */
    .tap-pointer {
      position: absolute;
      width: 36px; height: 36px;
      margin-left: -18px; margin-top: -18px;
      border-radius: 50%;
      pointer-events: none;
      z-index: 10;
    }
    .tap-pointer-dot {
      position: absolute;
      top: 50%; left: 50%;
      width: 12px; height: 12px;
      margin: -6px 0 0 -6px;
      background: var(--failure);
      border: 2px solid #fff;
      border-radius: 50%;
      box-shadow: 0 0 12px rgba(248, 113, 113, 0.6);
    }
    .tap-pointer-ring {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      border: 2px solid rgba(248, 113, 113, 0.5);
      border-radius: 50%;
      animation: tap-pulse 1.5s ease-out infinite;
    }
    @keyframes tap-pulse {
      0% { transform: scale(0.8); opacity: 1; }
      100% { transform: scale(2.2); opacity: 0; }
    }

    /* Step info sidebar */
    .step-info {
      padding: 20px;
      overflow-y: auto;
      border-left: 1px solid var(--border);
    }
    .info-section {
      margin-bottom: 18px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border);
    }
    .info-section:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }
    .info-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .info-value {
      font-size: 14px;
      color: var(--text-primary);
      font-weight: 500;
      line-height: 1.5;
      word-break: break-word;
    }
    .info-value.error { color: var(--failure); }
    .info-value.mono {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }
    .info-value.command {
      padding: 8px 10px;
      background: var(--bg-inset);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      font-size: 12px;
      line-height: 1.5;
    }

    @media (max-width: 1100px) {
      .workspace { grid-template-columns: 1fr; }
      .detail-body { grid-template-columns: 1fr; }
      .step-info { border-left: none; border-top: 1px solid var(--border); }
      .device-frame.ios, .device-frame.android { width: 240px; }
      .screenshot-frame { max-height: 440px; }
    }
    @media (max-width: 768px) {
      .workspace { grid-template-columns: 1fr; }
      .meta-strip { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main class="page">
    <!-- Header -->
    <header class="run-header animate-in">
      <div class="run-header-left">
        <a class="back-btn" href="/" title="Back to all runs">${iconArrowLeft()}</a>
        <div>
          <h1 class="run-title">${escapeHtml(name)}</h1>
          <div class="run-subtitle">
            <span>${escapeHtml(manifest.runId)}</span>
            <span class="sep">·</span>
            <span>${escapeHtml(formatDate(manifest.startedAt))}</span>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:14px;">
        ${renderStatusPill(manifest.success)}
        <div class="theme-toggle" id="theme-toggle">
          <button id="theme-light" onclick="setTheme('light')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            Light
          </button>
          <button id="theme-dark" onclick="setTheme('dark')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            Dark
          </button>
        </div>
      </div>
    </header>

    <!-- Meta Strip -->
    <section class="meta-strip animate-in animate-in-1">
      <div class="meta-chip">
        <span class="icon">${platformIcon}</span>
        <strong>${escapeHtml(manifest.platform)}</strong>
      </div>
      <div class="meta-chip">
        <span class="icon">${iconClock()}</span>
        <strong>${escapeHtml(formatDuration(manifest.durationMs))}</strong>
      </div>
      <div class="meta-chip">
        <span class="icon">${iconSteps()}</span>
        <strong>${manifest.stepsExecuted} / ${manifest.stepsTotal}</strong> steps
      </div>
      ${manifest.device ? `<div class="meta-chip"><span class="icon">${iconDevice()}</span><strong>${escapeHtml(manifest.device)}</strong></div>` : ""}
    </section>

    ${hasPhases ? renderPhaseTrack(manifest) : ""}

    ${!manifest.success && manifest.reason ? `
    <section class="failure-banner animate-in animate-in-2">
      <div class="failure-banner-icon">!</div>
      <div>
        <h3>Failure Analysis</h3>
        <p>${escapeHtml(manifest.reason)}</p>
      </div>
    </section>` : ""}

    <!-- Workspace -->
    <section class="workspace animate-in animate-in-3">
      <!-- Timeline -->
      <div class="timeline">
        <div class="timeline-header">
          <h3>Steps</h3>
          <span style="font-size:12px;color:var(--text-tertiary)">${manifest.steps.length} total</span>
        </div>
        <div class="timeline-scroll">
          ${renderStepTimeline(manifest)}
        </div>
      </div>

      <!-- Detail Panel -->
      <div class="detail">
        <div class="detail-header">
          <h3>Inspector</h3>
          <div class="screenshot-toggle" id="screenshot-toggle" style="display:none"></div>
        </div>
        <div class="detail-body">
          <div class="screenshot-area" id="screenshot-area">
            ${manifest.steps.length > 0 && manifest.steps[0].screenshotPath
              ? `<div class="device-frame ${escapeHtml(manifest.platform)}" id="device-frame">
                  ${manifest.platform === "ios"
                    ? '<div class="device-notch"></div>'
                    : '<div class="device-bezel-top"><div class="device-camera"></div><div class="device-speaker"></div></div>'}
                  <div class="${manifest.platform === "android" ? "device-screen" : ""}"><div class="screenshot-frame" id="screenshot-frame"><img id="screenshot-img" src="/artifacts/${escapeHtml(manifest.runId)}/${escapeHtml(manifest.steps[0].screenshotPath)}" alt="Step screenshot"></div></div>
                  ${manifest.platform === "ios"
                    ? '<div class="device-home"></div>'
                    : '<div class="device-bezel-bottom"><div class="nav-pill"></div></div>'}
                </div>`
              : `<div class="empty-screenshot" id="screenshot-frame">Select a step to view its screenshot</div>`}
          </div>
          <div class="step-info" id="step-info">
            ${manifest.steps.length > 0 ? renderStepDetailInfo(manifest.steps[0]) : ""}
          </div>
        </div>
      </div>
    </section>
  </main>

  <script>
    var steps = ${JSON.stringify(manifest.steps.map(s => ({
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
    }))).replace(/</g, "\\u003c")};
    var runId = ${JSON.stringify(manifest.runId).replace(/</g, "\\u003c")};
    var platform = ${JSON.stringify(manifest.platform).replace(/</g, "\\u003c")};
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

            var coordW, coordH;
            if (step.deviceScreenSize) {
              coordW = step.deviceScreenSize.width;
              coordH = step.deviceScreenSize.height;
            } else {
              coordW = img.naturalWidth || 360;
              coordH = img.naturalHeight || 800;
            }

            var pctX = (step.tapCoordinates.x / coordW) * 100;
            var pctY = (step.tapCoordinates.y / coordH) * 100;

            var pointer = document.createElement('div');
            pointer.className = 'tap-pointer';
            pointer.style.left = pctX + '%';
            pointer.style.top = pctY + '%';
            pointer.innerHTML = '<div class="tap-pointer-ring"></div><div class="tap-pointer-dot"></div>';
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
        html += '<div class="info-section"><div class="info-label">Command</div><div class="info-value command">' + esc(step.verbatim) + '</div></div>';
      }
      html += '<div class="info-section"><div class="info-label">Kind</div><div class="info-value">' + kindLabel(step.kind) + '</div></div>';
      html += '<div class="info-section"><div class="info-label">Phase</div><div class="info-value">' + step.phase + '</div></div>';
      html += '<div class="info-section"><div class="info-label">Status</div><div class="info-value' + (step.status === 'failed' ? ' error' : '') + '">' + step.status + '</div></div>';
      html += '<div class="info-section"><div class="info-label">Duration</div><div class="info-value mono">' + fmtMs(step.durationMs) + '</div></div>';

      if (step.tapCoordinates) {
        html += '<div class="info-section"><div class="info-label">Tap Coordinates</div><div class="info-value mono">[' + step.tapCoordinates.x + ', ' + step.tapCoordinates.y + ']</div></div>';
      }
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
  if (!manifest.phaseResults) return "";
  return `
    <section class="phase-track animate-in animate-in-2">
      ${manifest.phaseResults.map((pr) => {
        const cls = pr.success ? "passed" : "failed";
        return `
          <div class="phase-seg ${cls}">
            <span class="phase-name">${phaseLabel(pr.phase)}</span>
            <span class="phase-steps">${pr.stepsExecuted}/${pr.stepsTotal}</span>
          </div>`;
      }).join("")}
    </section>`;
}

function renderStepTimeline(manifest: RunManifest): string {
  const hasPhases = manifest.phaseResults && manifest.phaseResults.length > 0;
  let html = "";
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
  return `
    <button
      class="step-item${isFirst ? " selected" : ""}"
      data-step="${step.index}"
      onclick="selectStep(${step.index})"
      type="button"
    >
      <div class="step-item-row">
        <span class="step-num ${step.status}">${step.index + 1}</span>
        <div class="step-body">
          <div class="step-label">${escapeHtml(label)}</div>
          <div class="step-meta">
            <span>${stepKindIcon(step.kind)}</span>
            <span>${escapeHtml(stepKindLabel(step.kind))}</span>
          </div>
        </div>
        <span class="step-time">${escapeHtml(formatDuration(step.durationMs))}</span>
      </div>
      ${step.status === "failed" && step.error ? `<div class="step-error-inline">${escapeHtml(step.error)}</div>` : ""}
    </button>`;
}

function renderStepDetailInfo(step: StepArtifact): string {
  let html = "";
  if (step.verbatim) {
    html += `<div class="info-section"><div class="info-label">Command</div><div class="info-value command">${escapeHtml(step.verbatim)}</div></div>`;
  }
  html += `<div class="info-section"><div class="info-label">Kind</div><div class="info-value">${escapeHtml(stepKindLabel(step.kind))}</div></div>`;
  html += `<div class="info-section"><div class="info-label">Phase</div><div class="info-value">${escapeHtml(step.phase)}</div></div>`;
  html += `<div class="info-section"><div class="info-label">Status</div><div class="info-value${step.status === "failed" ? " error" : ""}">${escapeHtml(step.status)}</div></div>`;
  html += `<div class="info-section"><div class="info-label">Duration</div><div class="info-value mono">${escapeHtml(formatDuration(step.durationMs))}</div></div>`;
  if (step.error) {
    html += `<div class="info-section"><div class="info-label">Error</div><div class="info-value error">${escapeHtml(step.error)}</div></div>`;
  }
  return html;
}
