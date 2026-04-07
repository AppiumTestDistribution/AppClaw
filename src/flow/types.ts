/** Optional header (first YAML document before `---`) */
export interface FlowMeta {
  appId?: string;
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
  | ({ kind: 'type'; text: string; target?: string } & Verbatim)
  | ({ kind: 'enter' } & Verbatim)
  | ({ kind: 'back' } & Verbatim)
  | ({ kind: 'home' } & Verbatim)
  | ({ kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right'; repeat?: number } & Verbatim)
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
