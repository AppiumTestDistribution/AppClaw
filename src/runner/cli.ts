/**
 * `appclaw test` — the runner CLI.
 *
 * Resolves config (file ← CLI overrides), discovers spec files under `testDir`,
 * imports them (which registers their `test(...)` cases), then runs them across
 * the device pool. Exit code reflects pass/fail.
 *
 * Spec files are TypeScript; importing them at runtime requires a TS-capable
 * loader (e.g. run via `tsx`). Pre-compiled `.js` specs work under plain node.
 */

import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { config as loadDotenvFile } from 'dotenv';
import { findConfigFile, loadRunnerConfig, resolveConfig } from './config.js';
import { setCurrentFile, collectTests, resetRegistry } from './registry.js';
import { Runner } from './runner.js';
import type { CliOverrides, Platform } from './types.js';

interface ParsedArgs {
  configPath?: string;
  /** Path to a dotenv file to load before config is read (`--env-file`). */
  envFile?: string;
  overrides: CliOverrides;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  // Normalize --flag=value → --flag value
  const args = argv.flatMap((a) =>
    a.startsWith('--') && a.includes('=')
      ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
      : [a]
  );
  const overrides: CliOverrides = {};
  const testFilter: string[] = [];
  let configPath: string | undefined;
  let envFile: string | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '-c':
      case '--config':
        configPath = next();
        break;
      // `--env-file` is accepted here because Node only reserves that flag
      // before the script path, not in app args; `--env-path` is the alias.
      case '--env-file':
      case '--env-path':
        envFile = next();
        break;
      case '--retries':
        overrides.retries = Number(next());
        break;
      case '--workers':
        overrides.concurrency = Number(next());
        break;
      case '--timeout':
        overrides.timeout = Number(next());
        break;
      case '--grep':
        overrides.grep = next();
        break;
      case '--grep-invert':
        overrides.grepInvert = next();
        break;
      case '--reporter':
        overrides.reporter = [next()];
        break;
      case '--platform':
        overrides.platform = next() as Platform;
        break;
      case '--shard': {
        const [cur, tot] = (next() ?? '').split('/').map(Number);
        if (cur && tot) overrides.shard = { current: cur, total: tot };
        break;
      }
      default:
        if (!a.startsWith('-')) testFilter.push(a);
        break;
    }
  }
  if (testFilter.length) overrides.testFilter = testFilter;
  return { configPath, envFile, overrides, help };
}

/** Trailing literal of a simple star-glob like "*.spec.ts" (after the last star). */
function globSuffix(glob: string): string {
  const star = glob.lastIndexOf('*');
  return star >= 0 ? glob.slice(star + 1) : glob;
}

/** Recursively list files under `dir`, skipping node_modules and dotfolders. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function discoverSpecs(
  testDir: string,
  testMatch: string[],
  testIgnore: string[],
  filter: string[]
): Promise<string[]> {
  const root = path.resolve(testDir);
  const all = await walk(root);
  const suffixes = testMatch.map(globSuffix);
  return all
    .filter((f) => suffixes.some((s) => f.endsWith(s)))
    .filter((f) => !testIgnore.some((ig) => f.includes(globSuffix(ig))))
    .filter((f) => filter.length === 0 || filter.some((q) => f.includes(q)))
    .sort();
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: appclaw test [filter...] [options]

Options:
  -c, --config <file>     config file (default: appclaw.config.{ts,js})
  --env-file <path>       load a dotenv file before config (alias: --env-path)
  --workers <n>           parallel workers (default: device count)
  --retries <n>           retry failed tests up to n times
  --timeout <ms>          per-test timeout
  --grep <regex>          run only tests whose title matches
  --grep-invert <regex>   skip tests whose title matches
  --shard <x/n>           run shard x of n
  --reporter <name>       reporter (list, html, plain)
  --platform <p>          android | ios
  -h, --help              show this help

On an interactive terminal the run shows a live dashboard (devices, progress,
queue). Use --reporter plain or APPCLAW_TUI=off for line-by-line output (CI is
detected automatically).

Examples:
  appclaw test
  appclaw test tests/login.spec.ts
  appclaw test --workers 3 --retries 1
  appclaw test --shard 1/4`);
}

export async function runCli(argv: string[]): Promise<number> {
  const { configPath, envFile, overrides, help } = parseArgs(argv);
  if (help) {
    printHelp();
    return 0;
  }

  // Load a custom dotenv file before the config is imported, so values like
  // LLM_API_KEY are in process.env when appclaw.config.ts reads them. Without
  // this flag, dotenv still auto-loads a `.env` from the current directory.
  if (envFile) {
    const envFilePath = path.resolve(process.cwd(), envFile);
    if (!existsSync(envFilePath)) {
      // eslint-disable-next-line no-console
      console.error(`error: env file not found: ${envFile} (resolved to ${envFilePath})`);
      return 1;
    }
    const { error } = loadDotenvFile({ path: envFilePath, override: true, quiet: true });
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`error: failed to load env file ${envFile}: ${error.message}`);
      return 1;
    }
  }

  const resolvedConfigPath = configPath ?? (await findConfigFile());
  if (!resolvedConfigPath) {
    // eslint-disable-next-line no-console
    console.error('error: no appclaw.config.{ts,js} found. Create one or pass --config.');
    return 1;
  }

  const fileConfig = await loadRunnerConfig(resolvedConfigPath);
  const config = resolveConfig(fileConfig, overrides);

  // Resolve a relative capabilitiesFile against the config file's directory
  // (not cwd), so `./tests/caps.json` means "next to the config".
  const capsFile = config.appOptions.capabilitiesFile;
  if (capsFile && !path.isAbsolute(capsFile)) {
    config.appOptions.capabilitiesFile = path.resolve(path.dirname(resolvedConfigPath), capsFile);
  }

  const specs = await discoverSpecs(
    config.testDir,
    config.testMatch,
    config.testIgnore,
    config.testFilter
  );
  if (specs.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`No spec files found under "${config.testDir}".`);
    return 1;
  }

  resetRegistry();
  for (const spec of specs) {
    setCurrentFile(spec);
    await import(pathToFileURL(spec).href);
  }
  setCurrentFile(undefined);

  const cases = collectTests();
  if (cases.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`No tests found in ${specs.length} spec file(s) under "${config.testDir}".`);
    return 1;
  }

  // The reporter prints the run header (count + devices) once the pool is known.
  const runner = new Runner(config);
  try {
    const suite = await runner.run(cases);
    return suite.allPassed ? 0 : 1;
  } catch (err) {
    // Infra-level failure (no devices, node didn't start, etc.) — report it
    // cleanly and fail the run rather than dumping a stack trace.
    // eslint-disable-next-line no-console
    console.error(`\nerror: ${(err as Error).message}`);
    return 1;
  }
}
