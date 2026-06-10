export const VERSION = '0.1.0';

export function helpText(): string {
  return `appclaw-agent - terminal mobile automation for coding agents

Usage:
  appclaw-agent --session <name> <command> [options]

Run \`appclaw-agent help workflow\` for the recommended agent workflow.`;
}

export function workflowText(): string {
  return `Recommended AppClaw agent workflow:

1. Open a named session:
   appclaw-agent --session <name> open <app-id> --platform android|ios

2. Inspect actionable UI:
   appclaw-agent --session <name> snapshot -i --json

3. Use returned refs or stable selectors:
   appclaw-agent --session <name> press @e1 --json
   appclaw-agent --session <name> fill @e2 "text" --json
   appclaw-agent --session <name> press 'id="login_button"' --json

4. Scroll the screen or a specific container:
   appclaw-agent --session <name> scroll down --json        (scroll down — see content below)
   appclaw-agent --session <name> scroll up --json          (scroll up — see content above)
   appclaw-agent --session <name> scroll @e24 down --json   (scroll within a specific element)

   Always use "scroll", not "swipe" — they are aliases but "scroll down/up" is unambiguous.
   Never use "swipe @eN direction" — element-scoped swipe is not implemented.

   Re-run snapshot after every state-changing action; refs are invalidated.

   NOTE: snapshot reports DOM elements — it does not confirm visual on-screen
   presence. To verify what is actually rendered, take a screenshot instead:
   appclaw-agent --session <name> screenshot /tmp/screen.png

5. Press hardware keys:
   appclaw-agent --session <name> enter --json
   appclaw-agent --session <name> back --json
   appclaw-agent --session <name> home --json

6. Verify visual state:
   IMPORTANT: Always verify assertions visually via screenshot. DOM checks only confirm
   an element exists in the hierarchy — not that it is visible on screen. An element can
   be in the DOM but scrolled off-screen or clipped. Screenshot is the only reliable check.

   - Visual/rendered check (PREFERRED — actually on screen):
     appclaw-agent --session <name> screenshot /tmp/screen.png
     (then read the image file to analyze visually — base pass/fail on what you see)
   - DOM check (element exists in hierarchy, NOT a visibility guarantee):
     appclaw-agent --session <name> is visible 'text="Sign in"' --json
   - Vision check (requires AppClaw vision API key configured):
     appclaw-agent --session <name> is visible --vision "search icon" --json
     appclaw-agent --session <name> get info --vision "displayed total" --json
     When vision is NOT configured, these commands automatically capture a screenshot
     and return its path in screenshotPath — read that file to answer visually.

7. Close the session:
   appclaw-agent --session <name> close`;
}
