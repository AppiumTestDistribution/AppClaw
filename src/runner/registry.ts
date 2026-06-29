/**
 * Test registry — the collection layer.
 *
 * Spec files import `test`/`describe`/`beforeAll`/`afterAll` from
 * `appclaw/runner` and call them at module load; each call registers into this
 * module-global registry. The CLI imports the spec files (which populates the
 * registry), then reads it back with `collectTests()`. The programmatic
 * `Runner` uses the same registry via its `test`/`describe` proxies.
 *
 * Scopes: every test belongs to a chain of scopes — the file (root) plus each
 * enclosing `describe`. `beforeAll`/`afterAll` attach to the current scope; the
 * runner executes them once per (scope, device). Scope ids are looked up via
 * `getScope`.
 */

import type { AppClaw } from '../sdk/index.js';
import type { HookFn, TestCase, TestContext, TestOptions, FixtureArgs } from './types.js';
import type { FixtureDefs, ScopedFixtureDef } from './fixtures.js';

/** A scope's once-per-(scope,device) hooks. */
export interface ScopeDef {
  id: string;
  title: string;
  beforeAll: HookFn[];
  afterAll: HookFn[];
}

interface RegistryState {
  cases: TestCase[];
  scopes: Map<string, ScopeDef>;
  /** Active scope chain (ids), outermost (file) first — drives hooks. */
  scopeStack: string[];
  /** Active describe labels (no file/root) — drives display titles. */
  labelStack: string[];
  currentFile?: string;
}

const ROOT_SCOPE = '<root>';

const state: RegistryState = {
  cases: [],
  scopes: new Map(),
  scopeStack: [ROOT_SCOPE],
  labelStack: [],
};

function ensureScope(id: string, title: string): ScopeDef {
  let s = state.scopes.get(id);
  if (!s) {
    s = { id, title, beforeAll: [], afterAll: [] };
    state.scopes.set(id, s);
  }
  return s;
}

function currentScope(): ScopeDef {
  const id = state.scopeStack[state.scopeStack.length - 1];
  return ensureScope(id, id);
}

/** Set when the CLI is about to import a spec file, so cases are tagged by file. */
export function setCurrentFile(file: string | undefined): void {
  state.currentFile = file;
  // The file is the outermost scope; reset the stacks to it.
  const fileId = file ?? ROOT_SCOPE;
  state.scopeStack = [fileId];
  state.labelStack = [];
  ensureScope(fileId, file ?? ROOT_SCOPE);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => void | Promise<void>;

function register(title: string, fn: AnyFn, options: TestOptions, fixtures: FixtureDefs): void {
  const scopeIds = [...state.scopeStack];
  const prefix = state.labelStack.join(' › ');
  const fullTitle = prefix ? `${prefix} › ${title}` : title;
  state.cases.push({ title, fullTitle, fn, options, file: state.currentFile, scopeIds, fixtures });
}

/**
 * The two test-callback shapes the runner accepts. They're kept as separate
 * named types (not a union) so the call signatures below can expose them as
 * overloads — a *union* of function types defeats TS's contextual typing, so a
 * destructured `({ loggedInApp })` param would silently become `any`.
 *
 * The **fixtures form** is the primary, typed surface (first overload), so a
 * destructured arg always types correctly. The **positional form** is offered
 * for callbacks that take `ctx` (`(app, ctx) => …`) and is selected by arity —
 * a 2-arg function isn't assignable to the 1-arg fixtures overload, so TS falls
 * through to it. A single positional `(app) => …` is structurally identical to
 * a fixtures arg, so author single-arg tests as `({ app }) => …`. (The runtime
 * still detects and supports bare positional via `parseFirstParam`.)
 */
type FixturesCallback<Fx, State> = (args: FixtureArgs<State> & Fx) => void | Promise<void>;
type PositionalCallback<State> = (app: AppClaw, ctx: TestContext<State>) => void | Promise<void>;

/**
 * The `test` function exposed to spec authors. Overloads:
 *   test('name', async ({ app }) => { ... })                // fixtures (1 arg)
 *   test('name', async ({ app, loggedInApp }) => { ... })   // fixtures
 *   test('name', async (app, ctx) => { ... })               // positional + ctx
 *   test('name', { retries: 2 }, fn)
 *   test('name', { platform: 'android' }, fn)              // platform-gated
 * Plus `test.only`, `test.skip`, `test.android`, `test.ios`, and
 * `test.extend({ … })`. Platform-gated tests are reported as *skipped* (not
 * failed) on a run whose platform doesn't match.
 */
export interface TestApi<Fx = Record<never, never>> {
  <State = unknown>(title: string, fn: FixturesCallback<Fx, State>): void;
  <State = unknown>(title: string, fn: PositionalCallback<State>): void;
  <State = unknown>(title: string, options: TestOptions, fn: FixturesCallback<Fx, State>): void;
  <State = unknown>(title: string, options: TestOptions, fn: PositionalCallback<State>): void;
  only<State = unknown>(title: string, fn: FixturesCallback<Fx, State>): void;
  only<State = unknown>(title: string, fn: PositionalCallback<State>): void;
  skip<State = unknown>(title: string, fn: FixturesCallback<Fx, State>): void;
  skip<State = unknown>(title: string, fn: PositionalCallback<State>): void;
  /** Run only on Android; skipped (not failed) on an iOS run. */
  android<State = unknown>(title: string, fn: FixturesCallback<Fx, State>): void;
  android<State = unknown>(title: string, fn: PositionalCallback<State>): void;
  /** Run only on iOS; skipped (not failed) on an Android run. */
  ios<State = unknown>(title: string, fn: FixturesCallback<Fx, State>): void;
  ios<State = unknown>(title: string, fn: PositionalCallback<State>): void;
  /**
   * Compose new fixtures onto this test. Returns a new, typed `test`.
   *
   * Each fixture function's first arg is typed as the built-ins
   * (`app`, `device`, `state`, `title`, `retry`) plus every fixture in scope —
   * so destructuring `{ app }` / `{ device }` yields real types, not `unknown`.
   */
  extend<NewFx extends Record<string, unknown>>(defs: {
    [K in keyof NewFx]: ScopedFixtureDef<NewFx[K], FixtureArgs & Fx & NewFx>;
  }): TestApi<Fx & NewFx>;
}

function normalizeArgs(
  optionsOrFn: TestOptions | AnyFn,
  maybeFn?: AnyFn
): { options: TestOptions; fn: AnyFn } {
  if (typeof optionsOrFn === 'function') {
    return { options: {}, fn: optionsOrFn };
  }
  if (!maybeFn) throw new Error('test(name, options, fn): missing test function.');
  return { options: optionsOrFn, fn: maybeFn };
}

/** Build a `test` bound to a set of fixture definitions; `extend` merges more. */
function createTest<Fx>(fixtures: FixtureDefs): TestApi<Fx> {
  const t = ((title: string, optionsOrFn: TestOptions | AnyFn, maybeFn?: AnyFn) => {
    const { options, fn } = normalizeArgs(optionsOrFn, maybeFn);
    register(title, fn, options, fixtures);
  }) as TestApi<Fx>;
  t.only = ((title: string, fn: AnyFn) =>
    register(title, fn, { only: true }, fixtures)) as TestApi<Fx>['only'];
  t.skip = ((title: string, fn: AnyFn) =>
    register(title, fn, { skip: true }, fixtures)) as TestApi<Fx>['skip'];
  t.android = ((title: string, fn: AnyFn) =>
    register(title, fn, { platform: 'android' }, fixtures)) as TestApi<Fx>['android'];
  t.ios = ((title: string, fn: AnyFn) =>
    register(title, fn, { platform: 'ios' }, fixtures)) as TestApi<Fx>['ios'];
  t.extend = ((defs: FixtureDefs) => createTest({ ...fixtures, ...defs })) as TestApi<Fx>['extend'];
  return t;
}

export const test: TestApi = createTest<Record<never, never>>({});

/** Group tests under a label (nestable). Creates a child scope for hooks/titles. */
export function describe(label: string, body: () => void): void {
  const parentId = state.scopeStack[state.scopeStack.length - 1];
  const id = `${parentId} › ${label}`;
  ensureScope(id, label);
  state.scopeStack.push(id);
  state.labelStack.push(label);
  try {
    body();
  } finally {
    state.scopeStack.pop();
    state.labelStack.pop();
  }
}

/** Register a hook to run once before the current scope's tests (per device). */
export function beforeAll<State = unknown>(fn: HookFn<State>): void {
  currentScope().beforeAll.push(fn as HookFn);
}

/** Register a hook to run once after the current scope's tests (per device). */
export function afterAll<State = unknown>(fn: HookFn<State>): void {
  currentScope().afterAll.push(fn as HookFn);
}

/** Look up a scope's hooks by id (used by the runner). */
export function getScope(id: string): ScopeDef | undefined {
  return state.scopes.get(id);
}

/**
 * Return the collected cases, applying `.only` filtering: if any case is marked
 * `only`, only those run; the rest become skipped.
 */
export function collectTests(): TestCase[] {
  const hasOnly = state.cases.some((c) => c.options.only);
  if (!hasOnly) return [...state.cases];
  return state.cases.map((c) =>
    c.options.only ? c : { ...c, options: { ...c.options, skip: true } }
  );
}

/** Clear the registry (between runs / tests of the runner itself). */
export function resetRegistry(): void {
  state.cases = [];
  state.scopes = new Map();
  state.scopeStack = [ROOT_SCOPE];
  state.labelStack = [];
  state.currentFile = undefined;
}
