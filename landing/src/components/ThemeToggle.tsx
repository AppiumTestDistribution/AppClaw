import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const TRANSITION_MS = 220;

function applyTheme(next: Theme) {
  const root = document.documentElement;
  root.classList.add("theme-transitioning");
  if (next === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  window.setTimeout(() => {
    root.classList.remove("theme-transitioning");
  }, TRANSITION_MS + 40);
  try {
    localStorage.setItem("theme", next);
  } catch {}
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "dark" : "light");
  }, []);

  const toggle = () => {
    if (!theme) return;
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    applyTheme(next);
  };

  const isDark = theme === "dark";
  const ready = theme !== null;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      onClick={toggle}
      className="group relative inline-flex h-7 w-[64px] items-center rounded-full border border-border bg-secondary/60 hover:bg-secondary hover:border-foreground/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span
        aria-hidden
        className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 border-l border-dashed border-foreground/15"
      />

      <span
        aria-hidden
        className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 text-foreground/35"
      >
        <SunIcon className="h-3.5 w-3.5" />
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute right-[9px] top-1/2 -translate-y-1/2 text-foreground/35"
      >
        <MoonIcon className="h-3.5 w-3.5" />
      </span>

      <span
        className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-background border border-border shadow-[0_1px_3px_rgba(0,0,0,0.18)] flex items-center justify-center transition-[left,opacity,box-shadow] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:shadow-[0_2px_6px_rgba(0,0,0,0.22)] ${
          isDark ? "left-[40px]" : "left-[2px]"
        } ${ready ? "opacity-100" : "opacity-0"}`}
      >
        <SunIcon
          className={`absolute h-3 w-3 text-accent transition-opacity duration-200 ${
            !isDark ? "opacity-100" : "opacity-0"
          }`}
        />
        <MoonIcon
          className={`absolute h-3 w-3 text-accent transition-opacity duration-200 ${
            isDark ? "opacity-100" : "opacity-0"
          }`}
        />
      </span>
    </button>
  );
}

function SunIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
