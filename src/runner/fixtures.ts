/**
 * Playwright-style test fixtures.
 *
 * A fixture is a reusable piece of setup a test opts into by destructuring it
 * from the first argument:
 *
 *   const test = base.extend<{ loggedInApp: AppClaw }>({
 *     loggedInApp: async ({ app }, use) => {
 *       await app.run('Click on login button');   // setup
 *       await use(app);                            // hand to the test
 *       // teardown after the test
 *     },
 *   });
 *   test('…', async ({ loggedInApp }) => { … });
 *
 * Properties:
 *  - Lazy: a fixture is only built if a test (or another requested fixture)
 *    destructures it.
 *  - Dependency injection: a fixture declares its deps by destructuring them in
 *    its own first argument; they are built first.
 *  - use(value) setup/teardown: code before `use` is setup, code after is
 *    teardown (run in reverse dependency order).
 */

/** A fixture is either a plain value or a setup function using the `use` pattern. */
export type UseFn<T> = (value: T) => Promise<void>;
export type FixtureFn<T, Deps = Record<string, unknown>> = (
  deps: Deps,
  use: UseFn<T>
) => Promise<void> | void;

/**
 * Fixture scope:
 *  - `test` (default): built fresh for every test, torn down after that test.
 *  - `worker`: built once per worker (= once per device), reused across that
 *    worker's tests, torn down once when the worker drains its queue.
 */
export type FixtureScope = 'test' | 'worker';
export interface FixtureOptions {
  scope?: FixtureScope;
}

/**
 * A fixture definition: a plain value, a setup function, or a
 * `[fn | value, { scope }]` tuple to set the scope (Playwright-style).
 */
export type FixtureDef<T = unknown> =
  | T
  | FixtureFn<T>
  | [FixtureFn<T>, FixtureOptions]
  | [T, FixtureOptions];
export type FixtureDefs = Record<string, FixtureDef>;

/**
 * Like {@link FixtureDef} but with the function's deps typed — used by
 * `test.extend` so a fixture that destructures `{ app, device, … }` sees the
 * real `AppClaw` / `Device` types (and its sibling fixtures) instead of
 * `unknown`.
 */
export type ScopedFixtureDef<T, Deps> =
  | T
  | FixtureFn<T, Deps>
  | [FixtureFn<T, Deps>, FixtureOptions]
  | [T, FixtureOptions];

/** Scope of the runner-provided built-ins (worker-stable vs per-test). */
const BUILTIN_SCOPE: Record<string, FixtureScope> = {
  app: 'test', // fresh Appium session per test
  title: 'test',
  retry: 'test',
  device: 'worker', // same device for the whole worker
  state: 'worker', // run-scoped, stable within a worker
};

interface NormalizedDef {
  scope: FixtureScope;
  fn?: FixtureFn<unknown>;
  value?: unknown;
  isFn: boolean;
}

/** Normalize a def to `{ scope, fn|value }`. Plain defs are test-scoped. */
function normalizeDef(def: FixtureDef): NormalizedDef {
  if (
    Array.isArray(def) &&
    def.length === 2 &&
    typeof def[1] === 'object' &&
    def[1] !== null &&
    'scope' in (def[1] as object)
  ) {
    const [first, opts] = def as [unknown, FixtureOptions];
    const scope = opts.scope ?? 'test';
    return typeof first === 'function'
      ? { scope, fn: first as FixtureFn<unknown>, isFn: true }
      : { scope, value: first, isFn: false };
  }
  return typeof def === 'function'
    ? { scope: 'test', fn: def as FixtureFn<unknown>, isFn: true }
    : { scope: 'test', value: def, isFn: false };
}

/** The scope of a fixture or built-in by name. */
function scopeOf(name: string, defs: FixtureDefs): FixtureScope {
  if (name in BUILTIN_SCOPE) return BUILTIN_SCOPE[name];
  const def = defs[name];
  return def === undefined ? 'test' : normalizeDef(def).scope;
}

/**
 * Per-worker cache for worker-scoped fixtures. Built lazily on the first test
 * that needs each one; values reused across the worker's tests; teardowns run
 * once at worker drain via {@link teardownWorkerFixtures}.
 */
export interface WorkerFixtureStore {
  values: Map<string, unknown>;
  teardowns: Array<() => Promise<void>>;
}

export function createWorkerStore(): WorkerFixtureStore {
  return { values: new Map(), teardowns: [] };
}

/** Tear down all worker-scoped fixtures (reverse build order). */
export async function teardownWorkerFixtures(store: WorkerFixtureStore): Promise<void> {
  for (const t of [...store.teardowns].reverse()) {
    try {
      await t();
    } catch {
      /* best-effort — one worker fixture's teardown must not mask others */
    }
  }
  store.teardowns.length = 0;
  store.values.clear();
}

// ── First-parameter parsing ─────────────────────────────────────────
// To stay lazy we must know which fixtures a function destructures. We read
// that from the function's first parameter: an object pattern `{ a, b }` → it
// requests fixtures a and b; a plain identifier `app` → positional (legacy).

export interface ParamInfo {
  mode: 'object' | 'positional' | 'none';
  keys: string[];
}

/** Split a parameter/property list on top-level commas (ignores nested (){}[]). */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  const tail = src.slice(start);
  if (tail.trim()) parts.push(tail);
  return parts;
}

/** Keys destructured by an object pattern like `{ app, device: d, retry = 0 }`. */
function objectPatternKeys(pattern: string): string[] {
  const inner = pattern.trim().replace(/^\{/, '').replace(/\}$/, '');
  return splitTopLevel(inner)
    .map((p) => p.split(/[:=]/)[0].trim())
    .filter(Boolean)
    .filter((k) => k !== '...'); // ignore rest element marker
}

/** Inspect a function's first parameter. */
export function parseFirstParam(fn: (...args: unknown[]) => unknown): ParamInfo {
  let s = fn.toString().trimStart();
  // Strip a leading `async` — tsc keeps a space (`async (`), esbuild/tsx may
  // not (`async(`), so match the word boundary, not required whitespace.
  s = s.replace(/^async\b\s*/, '').trimStart();

  let paramList: string;
  if (s.startsWith('(')) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    paramList = end >= 0 ? s.slice(1, end) : '';
  } else {
    // Arrow function with a single unparenthesized param: `app => …`
    const m = s.match(/^([A-Za-z_$][\w$]*)\s*=>/);
    return m ? { mode: 'positional', keys: [m[1]] } : { mode: 'none', keys: [] };
  }

  const first = splitTopLevel(paramList)[0]?.trim() ?? '';
  if (!first) return { mode: 'none', keys: [] };
  if (first.startsWith('{')) return { mode: 'object', keys: objectPatternKeys(first) };
  const name = first.split(/[=\s]/)[0];
  return name ? { mode: 'positional', keys: [name] } : { mode: 'none', keys: [] };
}

// ── Resolution ──────────────────────────────────────────────────────

interface BuiltFixtures {
  values: Record<string, unknown>;
  /** Tear down all built fixtures in reverse order. */
  teardown(): Promise<void>;
}

/** Run a fixture function to its `use(value)` call and capture value + teardown. */
async function runFixtureFn(
  fn: FixtureFn<unknown>,
  deps: Record<string, unknown>
): Promise<{ value: unknown; teardown: () => Promise<void> }> {
  let value: unknown;
  let resolveUse!: () => void;
  let signalDone!: () => void;
  let usedCalled = false;
  let caught: unknown;

  const useReached = new Promise<void>((r) => (resolveUse = r));
  const testDone = new Promise<void>((r) => (signalDone = r));

  const ran = (async () => {
    try {
      await fn(deps, async (v: unknown) => {
        value = v;
        usedCalled = true;
        resolveUse();
        await testDone; // suspend the fixture here until the test finishes
      });
    } catch (err) {
      caught = err;
    } finally {
      resolveUse(); // unblock setup even if use() was never called / threw
    }
  })();

  await useReached;
  if (caught && !usedCalled) throw caught; // setup-phase failure

  return {
    value,
    teardown: async () => {
      signalDone();
      await ran;
      if (caught) throw caught; // teardown-phase failure
    },
  };
}

/**
 * Build the fixtures a test requested (plus their transitive deps), starting
 * from the runner-provided built-ins (app, device, state, …).
 *
 * Worker-scoped fixtures are pulled from / stored in `worker` so they are built
 * once per worker and reused; their teardowns run at worker drain. Test-scoped
 * fixtures are built here and the returned `teardown` disposes them after the
 * test. Returns the merged values for the test to consume.
 */
export async function buildFixtures(
  requested: string[],
  defs: FixtureDefs,
  builtins: Record<string, unknown>,
  worker: WorkerFixtureStore
): Promise<BuiltFixtures> {
  const values: Record<string, unknown> = { ...builtins };
  // Seed already-built worker fixtures so they're reused, not rebuilt.
  for (const [k, v] of worker.values) values[k] = v;

  const done = new Set<string>([...Object.keys(builtins), ...worker.values.keys()]);
  const inProgress = new Set<string>();
  const testTeardowns: Array<() => Promise<void>> = [];

  async function ensure(name: string): Promise<void> {
    if (done.has(name)) return;
    if (!(name in defs)) {
      throw new Error(
        `Unknown fixture "${name}". Define it via test.extend({ ${name}: … }) or ` +
          `destructure only built-ins (app, device, state, title, retry).`
      );
    }
    if (inProgress.has(name)) throw new Error(`Fixture dependency cycle at "${name}".`);
    inProgress.add(name);

    const def = normalizeDef(defs[name]);

    if (def.isFn) {
      const fn = def.fn as FixtureFn<unknown>;
      // Deps are only the fixtures this fixture *destructures* (`{ app }`). A
      // positional first param (`_`, `fixtures`) declares no specific deps.
      const info = parseFirstParam(fn as never);
      const depKeys = info.mode === 'object' ? info.keys : [];

      // A worker-scoped fixture must not depend on test-scoped fixtures/built-ins
      // (e.g. `app`, which is a fresh session per test) — that would capture a
      // value that's stale by the next test. Fail loudly instead.
      if (def.scope === 'worker') {
        for (const dep of depKeys) {
          if (scopeOf(dep, defs) === 'test') {
            throw new Error(
              `Worker-scoped fixture "${name}" cannot depend on test-scoped "${dep}". ` +
                `Worker fixtures may only use other worker fixtures or "device" / "state".`
            );
          }
        }
      }

      for (const dep of depKeys) await ensure(dep);
      const deps = Object.fromEntries(depKeys.map((k) => [k, values[k]]));
      const { value, teardown } = await runFixtureFn(fn, deps);
      values[name] = value;
      if (def.scope === 'worker') {
        worker.values.set(name, value);
        worker.teardowns.push(teardown);
      } else {
        testTeardowns.push(teardown);
      }
    } else {
      values[name] = def.value;
      if (def.scope === 'worker') worker.values.set(name, def.value);
    }

    inProgress.delete(name);
    done.add(name);
  }

  for (const name of requested) await ensure(name);

  return {
    values,
    async teardown() {
      // Only test-scoped fixtures dispose here; worker fixtures live until drain.
      for (const t of testTeardowns.reverse()) {
        try {
          await t();
        } catch {
          /* best-effort — a fixture teardown failure must not mask others */
        }
      }
    },
  };
}
