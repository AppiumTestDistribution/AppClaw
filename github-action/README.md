# AppClaw Mobile Tests — GitHub Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-AppClaw%20Mobile%20Tests-purple?logo=github)](https://github.com/marketplace/actions/appclaw-mobile-tests)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

Run [AppClaw](https://github.com/AppiumTestDistribution/AppClaw) mobile UI automation flows and AI-driven goals directly in GitHub Actions — Android emulator or iOS simulator included, zero boilerplate.

---

## Quick start

### Android — run a YAML flow

```yaml
name: Mobile Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest   # Android requires Ubuntu (KVM-enabled)
    steps:
      - uses: actions/checkout@v4

      - uses: AppiumTestDistribution/AppClaw/github-action@v1
        with:
          flow: flows/login.yaml
          platform: android
          api-key: ${{ secrets.GEMINI_API_KEY }}
```

### Android — run a natural language goal

```yaml
      - uses: AppiumTestDistribution/AppClaw/github-action@v1
        with:
          goal: 'Open YouTube, search for Appium 3.0, verify the first result is visible'
          platform: android
          api-key: ${{ secrets.GEMINI_API_KEY }}
```

### iOS — run a YAML flow

```yaml
jobs:
  test:
    runs-on: macos-14   # iOS requires macOS (Apple Silicon)
    steps:
      - uses: actions/checkout@v4

      - uses: AppiumTestDistribution/AppClaw/github-action@v1
        with:
          flow: flows/ios-login.yaml
          platform: ios
          api-key: ${{ secrets.GEMINI_API_KEY }}
```

---

## Inputs

| Input | Required | Default | Description |
|-------|:--------:|---------|-------------|
| `flow` | one of¹ | — | Path to a YAML flow file relative to repo root |
| `goal` | one of¹ | — | Natural language goal executed by the LLM agent |
| `platform` | no | `android` | Target platform: `android` or `ios` |
| `provider` | no | `gemini` | LLM provider: `gemini`, `anthropic`, `openai`, `groq` |
| `api-key` | **yes** | — | LLM API key for the chosen provider |
| `agent-mode` | no | `dom` | `dom` (element locators) or `vision` (screenshot AI) |
| `android-api-level` | no | `33` | Android emulator API level (33 = Android 13) |
| `android-profile` | no | `pixel_6` | Android AVD hardware profile |
| `android-target` | no | `default` | Emulator target: `default` or `google_apis` |
| `max-steps` | no | `30` | Maximum agent steps before the run fails |
| `step-delay` | no | `500` | Milliseconds between steps |
| `report` | no | `true` | Upload HTML report as a workflow artifact |
| `report-name` | no | `appclaw-report` | Name of the uploaded artifact |
| `appclaw-version` | no | `latest` | npm package version to pin (e.g. `0.1.7`) |

¹ Provide either `flow` **or** `goal`, not both.

## Outputs

| Output | Description |
|--------|-------------|
| `report-path` | Path to the generated `.appclaw/runs/<id>/` directory |

---

## Writing YAML flows

```yaml
# flows/search.yaml
platform: android
---
steps:
  - open YouTube app
  - wait for search icon to be visible
  - tap Search
  - type Appium 3.0
  - tap the first result
  - wait 3 seconds
  - scroll down
  - verify screen has video uploaded by TestMu AI
  - done
```

See the [AppClaw YAML flow docs](https://github.com/AppiumTestDistribution/AppClaw#yaml-flows) for the full syntax (phases, variables, parallel, assertions).

---

## Secrets setup

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name | Provider |
|-------------|----------|
| `GEMINI_API_KEY` | Google Gemini (recommended — free tier available) |
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT-4 |

---

## Examples

### Parallel matrix — run multiple flows concurrently

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        flow:
          - flows/login.yaml
          - flows/search.yaml
          - flows/checkout.yaml
    steps:
      - uses: actions/checkout@v4

      - uses: AppiumTestDistribution/AppClaw/github-action@v1
        with:
          flow: ${{ matrix.flow }}
          platform: android
          api-key: ${{ secrets.GEMINI_API_KEY }}
          report-name: report-${{ strategy.job-index }}
```

### Pin AppClaw version

```yaml
      - uses: AppiumTestDistribution/AppClaw/github-action@v1
        with:
          flow: flows/smoke.yaml
          platform: android
          api-key: ${{ secrets.GEMINI_API_KEY }}
          appclaw-version: '0.1.7'
```

### Use report path in a downstream step

```yaml
      - uses: AppiumTestDistribution/AppClaw/github-action@v1
        id: appclaw
        with:
          flow: flows/login.yaml
          platform: android
          api-key: ${{ secrets.GEMINI_API_KEY }}

      - name: Print report location
        run: echo "Report at ${{ steps.appclaw.outputs.report-path }}"
```

### Vision mode (screenshot-based AI)

```yaml
      - uses: AppiumTestDistribution/AppClaw/github-action@v1
        with:
          flow: flows/onboarding.yaml
          platform: android
          agent-mode: vision
          api-key: ${{ secrets.GEMINI_API_KEY }}
```

### Nightly regression on a schedule

```yaml
on:
  schedule:
    - cron: '0 2 * * *'   # 2 AM UTC every night

jobs:
  nightly:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: AppiumTestDistribution/AppClaw/github-action@v1
        with:
          flow: flows/full-regression.yaml
          platform: android
          api-key: ${{ secrets.GEMINI_API_KEY }}
          report-name: nightly-report-${{ github.run_id }}
```

---

## Reports

When `report: true` (default), an HTML report is uploaded as a workflow artifact after each run. Download it from the **Actions run summary → Artifacts**. The report includes:

- Step-by-step screenshots with tap overlays
- Pass/fail status per step
- Execution timeline
- Screen recording (if `video: true` is set in your flow's `appClaw` options)

To view reports locally after downloading:

```bash
npx appclaw --report
```

---

## Runner requirements

| Platform | Runner | Notes |
|----------|--------|-------|
| `android` | `ubuntu-latest` | Free tier. KVM-enabled. Emulator boots in ~4–6 min. |
| `ios` | `macos-14` | Apple Silicon. macOS minutes cost ~10× Linux. |

> **iOS tip:** For faster iOS CI, use [LambdaTest](https://github.com/AppiumTestDistribution/AppClaw#lambdatest) cloud devices on `ubuntu-latest` instead of a macOS runner.

---

## Full example workflows

Ready-to-copy workflow files are in the [`examples/`](./examples/) directory:

| File | Description |
|------|-------------|
| [`android-flow.yml`](./examples/android-flow.yml) | Android YAML flow |
| [`android-goal.yml`](./examples/android-goal.yml) | Android natural language goal |
| [`ios-flow.yml`](./examples/ios-flow.yml) | iOS simulator YAML flow |
| [`matrix-parallel.yml`](./examples/matrix-parallel.yml) | Parallel matrix across multiple flows |
| [`full-pipeline.yml`](./examples/full-pipeline.yml) | Full CI/CD pipeline with lint + test + report |

---

## License

MIT © [AppiumTestDistribution](https://github.com/AppiumTestDistribution)
