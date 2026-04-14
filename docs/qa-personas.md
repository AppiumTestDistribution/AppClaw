# QA: Test Persona Profiles

## Problem

Every QA test run requires a specific user context — free vs premium, new vs returning, admin vs regular. Currently this must be spelled out in the goal on every run, making flows verbose and hard to reuse.

## Proposed Design

### Persona files at `.appclaw/env/personas/<name>.yaml`

```yaml
# .appclaw/env/personas/premium-user.yaml
name: premium-user
credentials:
  email: qa+premium@company.com
  password: $SECRET_PREMIUM_PASS # interpolated from .appclaw/env/secrets
state:
  subscription: active
  cart: empty
  onboarding: completed
  notifications: denied
```

### CLI usage

```bash
appclaw --flow checkout.yaml --persona premium-user
appclaw --flow onboarding.yaml --persona new-user
```

### YAML flow usage

```yaml
persona: premium-user
steps:
  - tap the checkout button
  - ...
```

## How It Works

1. Persona file is loaded at run start
2. Persona fields are injected into the LLM system prompt as context:
   ```
   CURRENT USER PERSONA: premium-user
   - Subscription: active
   - Cart: empty
   - Onboarding: completed
   ```
3. Credentials are available for interpolation in steps:
   ```yaml
   - type $persona.credentials.email into the email field
   ```
4. Secrets (values starting with `$`) are resolved from `.appclaw/env/secrets` before injection

## Personas to Ship With (Examples)

- `new-user` — no account, fresh install state
- `free-user` — logged in, free tier limits apply
- `premium-user` — logged in, all features unlocked
- `admin` — elevated permissions

## Files to Touch

- `src/flow/run-yaml-flow.ts` — load and inject persona at run start
- `src/config.ts` — add `--persona` CLI flag
- `src/llm/prompts.ts` — inject persona context into system prompt
- New: `src/persona/loader.ts` — load, validate, interpolate persona files
