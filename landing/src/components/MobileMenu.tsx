import { useState } from "react";
import ThemeToggle from "./ThemeToggle";

const NAV_LINKS = [
  { label: "Parallel", href: "#parallel" },
  { label: "Features", href: "#features" },
  { label: "AppGuide", href: "#appguide" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Architecture", href: "#architecture" },
  { label: "Usage Guide", href: "/usage.html" },
];

export default function MobileMenu() {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex flex-col gap-1.5 p-2 cursor-pointer"
        aria-label="Toggle menu"
      >
        <span
          className={`block h-[1.5px] w-5 bg-foreground transition-transform duration-200 ${open ? "translate-y-[4.5px] rotate-45" : ""}`}
        />
        <span
          className={`block h-[1.5px] w-5 bg-foreground transition-opacity duration-200 ${open ? "opacity-0" : ""}`}
        />
        <span
          className={`block h-[1.5px] w-5 bg-foreground transition-transform duration-200 ${open ? "-translate-y-[4.5px] -rotate-45" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 bg-background border-b border-border px-6 py-6 flex flex-col gap-4 shadow-lg z-50">
          {NAV_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              onClick={() => setOpen(false)}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {link.label}
            </a>
          ))}
          <a
            href="https://github.com/AppiumTestDistribution/appclaw#quick-start"
            onClick={() => setOpen(false)}
            className="inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-medium"
          >
            Get Started
          </a>
          <div className="mt-2 pt-4 border-t border-border flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-medium">
              Theme
            </span>
            <ThemeToggle />
          </div>
        </div>
      )}
    </div>
  );
}
