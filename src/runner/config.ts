/**
 * Config layer for the runner.
 *
 * Resolution precedence (highest wins): CLI flag → appclaw.config.ts → default.
 * `defineConfig` is an identity helper that gives authors type-checking on the
 * config object; `findConfigFile` + `loadRunnerConfig` locate and import it;
 * `resolveConfig` merges file + CLI overrides into the flat `ResolvedConfig`
 * the engine reads.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { RunnerConfig, ResolvedConfig, CliOverrides, Platform } from './types.js';

/** Built-in defaults — the floor of the precedence chain. */
const DEFAULTS = {
  testDir: 'tests',
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  testIgnore: [] as string[],
  platform: 'android' as Platform,
  concurrency: 'auto' as const,
  retries: 0,
  timeout: 120_000,
  reporter: ['list'],
  reportDir: '.appclaw/runs',
};

/** Candidate config filenames, in priority order. */
const CONFIG_NAMES = [
  'appclaw.config.ts',
  'appclaw.config.mts',
  'appclaw.config.js',
  'appclaw.config.mjs',
];

/**
 * Type-checked identity helper. Authors write:
 *   export default defineConfig({ testDir: 'tests', retries: 1, ... })
 */
export function defineConfig<State = unknown>(config: RunnerConfig<State>): RunnerConfig<State> {
  return config;
}

/** Find the nearest config file walking up from `cwd`. Returns null if none. */
export async function findConfigFile(cwd = process.cwd()): Promise<string | null> {
  let dir = path.resolve(cwd);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Import a config file and return its default export. */
export async function loadRunnerConfig(configPath: string): Promise<RunnerConfig> {
  const mod = await import(pathToFileURL(path.resolve(configPath)).href);
  const config = mod.default ?? mod.config ?? mod;
  if (!config || typeof config !== 'object') {
    throw new Error(`Config at ${configPath} has no default export object.`);
  }
  return config as RunnerConfig;
}

function asArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Merge built-in defaults, the config file, and CLI overrides into the flat
 * settings the engine reads. CLI wins over config wins over defaults.
 */
export function resolveConfig(fileConfig: RunnerConfig, cli: CliOverrides = {}): ResolvedConfig {
  // Split runner-only orchestration fields from the AppClaw pass-through bag.
  // Everything NOT destructured here is an AppClawOptions field and flows to
  // every test's session via `appOptions`.
  const {
    testDir,
    testMatch,
    testIgnore,
    concurrency,
    retries,
    timeout,
    node,
    reporter,
    reportDir,
    globalSetup,
    globalTeardown,
    deviceSetup,
    beforeEach,
    afterEach,
    ...appOptions
  } = fileConfig;

  const platform = cli.platform ?? appOptions.platform ?? DEFAULTS.platform;

  return {
    testDir: testDir ?? DEFAULTS.testDir,
    testMatch: asArray(testMatch) ?? DEFAULTS.testMatch,
    testIgnore: asArray(testIgnore) ?? DEFAULTS.testIgnore,
    testFilter: cli.testFilter ?? [],

    platform,
    concurrency: cli.concurrency ?? concurrency ?? DEFAULTS.concurrency,
    retries: cli.retries ?? retries ?? DEFAULTS.retries,
    timeout: cli.timeout ?? timeout ?? DEFAULTS.timeout,

    node: { local: node?.local ?? true, ...node },
    // Carry the full AppClaw option surface through; pin the resolved platform
    // so AppClaw targets the same platform the runner discovered devices for.
    appOptions: { ...appOptions, platform },
    reporter: cli.reporter ?? asArray(reporter) ?? DEFAULTS.reporter,
    reportDir: reportDir ?? DEFAULTS.reportDir,

    grep: cli.grep,
    grepInvert: cli.grepInvert,
    shard: cli.shard,

    globalSetup,
    globalTeardown,
    deviceSetup,
    beforeEach,
    afterEach,
  };
}
