# QA: Named Setup Steps / Step Libraries

## Problem

Common setup sequences (login, clear cart, reset permissions, onboard a new user) are written out in full in every flow file that needs them. When the login flow changes, every flow that embeds it must be updated. There is no reuse.

## Concept

Named step sequences stored as shared YAML fragments, referenced from any flow:

```yaml
# .appclaw/steps/login-as-admin.yaml
name: login-as-admin
description: Log in using admin credentials, handle 2FA if prompted
steps:
  - tap the Sign In button
  - type $persona.credentials.email into the email field
  - type $persona.credentials.password into the password field
  - tap Login
  - if OTP screen appears, wait for human input
```

Referenced in any flow:

```yaml
setup:
  - use: login-as-admin
  - use: clear-cart

steps:
  - tap checkout
  - ...
```

## Step Library Locations

Resolution order (first match wins):

1. `.appclaw/steps/` — project-level, checked into repo
2. `~/.appclaw/steps/` — user-level, shared across projects
3. Built-in steps shipped with AppClaw (login helpers, permission handlers)

## Built-in Steps to Ship

| Name                    | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `dismiss-notifications` | Deny notification permission prompt if it appears |
| `dismiss-tracking`      | Deny app tracking permission if it appears        |
| `clear-cart`            | Navigate to cart and remove all items             |
| `logout`                | Navigate to account settings and log out          |
| `wait-for-network`      | Wait until a loading spinner disappears           |

## Composability

Steps can reference other steps:

```yaml
# .appclaw/steps/fresh-checkout-session.yaml
steps:
  - use: logout
  - use: login-as-free-user
  - use: clear-cart
```

## Discoverable via CLI

```bash
appclaw --list-steps                    # list all available named steps
appclaw --list-steps --filter login     # filter by name
appclaw --run-step login-as-admin       # run a single step in isolation
```

## Files to Touch

- `src/flow/parse-yaml-flow.ts` — resolve `use:` references, load step files
- `src/flow/run-yaml-flow.ts` — execute referenced steps inline
- New: `src/flow/step-library.ts` — resolve step files from project + user + built-in paths
- `src/config.ts` — add `--list-steps`, `--run-step` flags
- New: `src/flow/builtin-steps/` — built-in step YAML files
