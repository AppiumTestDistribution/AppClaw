/** Optional header (first YAML document before `---`) */
export interface FlowMeta {
  appId?: string;
  /**
   * Local file path or HTTP(S) URL to the app to install for this flow (APK/IPA).
   * Passed as `appium:app` capability at session creation so Appium installs it automatically.
   * Overrides the global APP_PATH env var.
   *
   * Single string (same URL for all platforms):
   *   `app: https://example.com/MyApp.apk`
   *
   * Platform-specific URLs:
   *   ```yaml
   *   app:
   *     android: https://example.com/MyApp.apk
   *     ios: https://example.com/MyApp.zip
   *   ```
   */
  app?: string | { android?: string; ios?: string };
  name?: string;
  description?: string;
  platform?: 'android' | 'ios';
  /** Environment name — resolved from `.appclaw/env/<name>.yaml` or `--env` CLI flag */
  env?: string;
  /** Inline env block for self-contained flows */
  inlineEnv?: Record<string, unknown>;
  /**
   * Number of devices to run this flow against in parallel.
   * Requires that many devices to be available (e.g. `parallel: 2`).
   */
  parallel?: number;
}

/**
 * A test suite: a collection of YAML flow files to run together.
 *
 * Example suite.yaml:
 * ```yaml
 * name: regression_suite
 * platform: android
 * parallel: 2        # run up to 2 flows concurrently across devices
 * flows:
 *   - flows/login.yaml
 *   - flows/checkout.yaml
 *   - flows/search.yaml
 * ```
 */
export interface ParsedSuite {
  meta: FlowMeta;
  /** Resolved absolute paths to the individual flow YAML files */
  flows: string[];
}

/** Set when the step was parsed from a natural-language YAML string (shown in CLI). */
type Verbatim = { verbatim?: string };

export type FlowStep =
  | ({ kind: 'launchApp' } & Verbatim)
  | ({ kind: 'openApp'; query: string } & Verbatim)
  | ({ kind: 'wait'; seconds: number } & Verbatim)
  | ({
      kind: 'waitUntil';
      condition: 'visible' | 'gone' | 'screenLoaded';
      text?: string;
      timeoutSeconds: number;
    } & Verbatim)
  | ({ kind: 'tap'; label: string } & Verbatim)
  | ({ kind: 'longPress'; label: string; duration?: number } & Verbatim)
  | ({ kind: 'type'; text: string; target?: string } & Verbatim)
  | ({ kind: 'enter' } & Verbatim)
  | ({ kind: 'back' } & Verbatim)
  | ({ kind: 'home' } & Verbatim)
  | ({ kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right'; repeat?: number } & Verbatim)
  | ({
      kind: 'drag';
      from: string;
      to: string;
      /** Drag movement duration in ms. Default: 600 */
      duration?: number;
      /** Hold duration before dragging in ms. Default: 400 */
      longPressDuration?: number;
    } & Verbatim)
  | ({ kind: 'assert'; text: string } & Verbatim)
  | ({
      kind: 'scrollAssert';
      text: string;
      direction: 'up' | 'down' | 'left' | 'right';
      maxScrolls: number;
    } & Verbatim)
  | ({ kind: 'getInfo'; query: string } & Verbatim)
  | ({ kind: 'done'; message?: string } & Verbatim);

/**
 * Execution phase of a flow step.
 * - setup: initialization steps (app launch, login, navigation to starting screen)
 * - test: main test steps (the actions under test)
 * - assertion: verification checks (expected outcomes)
 */
export type FlowPhase = 'setup' | 'test' | 'assertion';

/** A step tagged with its execution phase. */
export interface PhasedStep {
  step: FlowStep;
  phase: FlowPhase;
}

export interface ParsedFlow {
  meta: FlowMeta;
  steps: FlowStep[];
  /**
   * When the YAML uses setup/steps/assertions sections, steps are
   * organized by phase. When using a flat step list (legacy), all
   * steps default to "test" phase.
   */
  phases: PhasedStep[];
}

/** Per-phase execution result for structured reporting. */
export interface PhaseResult {
  phase: FlowPhase;
  success: boolean;
  stepsExecuted: number;
  stepsTotal: number;
  failedAt?: number;
  reason?: string;
}

/** Resolve the app path/URL for a given platform from a FlowMeta.app value. */
export function resolveFlowApp(
  app: FlowMeta['app'],
  platform: 'android' | 'ios' | null | undefined
): string | undefined {
  if (!app) return undefined;
  if (typeof app === 'string') return app;
  return platform === 'ios' ? app.ios : app.android;
}
