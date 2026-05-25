---
name: use-appclaw-agent-cli
description: >
  Use the appclaw-agent CLI to directly open, inspect, and interact with a
  mobile app via terminal commands — without writing a YAML flow. Trigger this
  skill when the user asks to open an app, tap or fill a UI element, check
  visibility, or perform any one-off device interaction that does not require a
  reusable flow file.
---

# AppClaw Agent CLI

When the user asks you to operate or inspect a mobile device interactively
(open an app, tap a button, check visibility, etc.) using terminal commands
rather than a YAML flow:

1. Verify that `appclaw-agent` is installed and run `appclaw-agent help workflow`.
2. Use a descriptive named session for the task.
3. Inspect with `snapshot -i --json` before choosing a target.
4. Prefer returned `@eN` references or durable selectors for interaction.
5. Request a new snapshot after each state-changing action.
6. Use `--vision` only when explicitly requested or when visual targeting is required and configured.

## Scrolling — direction reference

**Always use `scroll`, never `swipe`.** `scroll` and `swipe` are aliases in the parser, but `scroll` reads unambiguously — `scroll down` means scroll down, `scroll up` means scroll up.

| Goal | Command |
|---|---|
| See content **below** (scroll down) | `appclaw-agent --session <name> scroll down --json` |
| See content **above** (scroll up) | `appclaw-agent --session <name> scroll up --json` |
| Scroll down within an element | `appclaw-agent --session <name> scroll @eN down --json` |
| Scroll up within an element | `appclaw-agent --session <name> scroll @eN up --json` |

**Never use `swipe`** — `swipe up` is ambiguous (training data says it scrolls down; AppClaw treats it as scroll up). Using `scroll` eliminates the confusion entirely.

**Never use `swipe @eN direction`** — element-scoped swipe crashes (`swipeElement is not a function`). Use `scroll @eN direction` instead.
7. Close the named session when the task is complete.

## Assertions must always be visual

**Never use DOM presence (`is visible`, snapshot element checks) as the sole assertion.** The DOM may contain elements that are off-screen, scrolled out of view, or clipped — DOM presence does not mean the user can see it.

For every assertion or verification step:
1. Take a screenshot: `appclaw-agent --session <name> screenshot /tmp/<name>.png`
2. Read the screenshot image with the Read tool and visually analyze what is actually rendered on screen.
3. Base your pass/fail verdict **only on what you can see in the screenshot**, not on DOM presence.
4. If the target content is not clearly visible in the screenshot, the assertion **fails** — even if a DOM element exists for it.

This applies to any check phrased as "verify X is present", "confirm X appears", "assert X is visible", or similar.

The installed CLI help is the source of truth for supported commands.

