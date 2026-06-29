/**
 * `appclaw init` — interactive project scaffolder.
 *
 * Generates a ready-to-run **Test Runner** project: an `appclaw.config.ts`, a
 * sample spec, a `.env.example` (full reference template — never prompts for the
 * key) plus an empty `.env` for your secrets, `package.json` scripts + devDeps,
 * a `tsconfig.json`, and `.gitignore` entries. It only writes files and prints
 * next steps — it never installs packages or touches the network.
 *
 * Non-destructive: existing files are skipped (with a note) unless `--force`;
 * `package.json` and `.gitignore` are *merged*, not overwritten.
 *
 * Flags: `appclaw init [dir] [--platform android|ios] [--provider <p>] [--yes] [--force]`
 * `--yes` (or a non-TTY stdin) runs with defaults/flags and no prompts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import { interactivePicker, type PickerItem } from '../device/interactive-picker.js';
import { DEFAULT_MODELS } from '../constants.js';

/**
 * Minimum appclaw version pinned into the scaffolded package.json. `appclaw init`
 * and the Test Runner first ship in 1.9.0, so a generated project must require at
 * least that — not the running CLI's `VERSION`, which may be an older global.
 */
const MIN_APPCLAW_VERSION = '1.9.0';

/** Minimal local palette (mirrors src/ui/terminal.ts, which keeps `theme` private). */
const theme = {
  brand: chalk.hex('#FC8EAC'),
  dim: chalk.dim,
  info: chalk.cyan,
  step: chalk.hex('#9CC6F5'),
};

type Platform = 'android' | 'ios';
type Provider = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'ollama';
type AgentMode = 'dom' | 'vision';

interface InitChoices {
  dir: string;
  platform: Platform;
  provider: Provider;
  agentMode: AgentMode;
}

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT)' },
  { value: 'gemini', label: 'Google (Gemini)' },
  { value: 'groq', label: 'Groq' },
  { value: 'ollama', label: 'Ollama (local, no API key)' },
];

/* ───────────────────────── arg parsing ─────────────────────────── */

interface ParsedArgs {
  dir?: string;
  platform?: Platform;
  provider?: Provider;
  yes: boolean;
  force: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { yes: false, force: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--platform') out.platform = args[++i] as Platform;
    else if (a === '--provider') out.provider = args[++i] as Provider;
    else if (!a.startsWith('-') && !out.dir) out.dir = a;
  }
  return out;
}

/* ───────────────────────── prompts ─────────────────────────────── */

/**
 * A single readline interface reused for every prompt. Creating one interface
 * per question loses buffered input on a piped stdin and can leave the stream
 * half-closed (the old "unsettled top-level await" hang). One interface, closed
 * once, fixes that. On EOF/Ctrl-D every pending and future prompt resolves to
 * its default, so the wizard always settles — TTY, piped, or closed stdin.
 *
 * Plain numbered line prompts (no raw-mode arrow keys) so it works on any
 * readable stdin, including IDE terminals where `stdin.isTTY` is false — which
 * is exactly where the old picker-gated flow silently skipped every question.
 */
class Prompter {
  private rl: readline.Interface;
  private closed = false;
  private queue: string[] = []; // lines that arrived before a question was waiting
  private waiter?: (line: string | null) => void;

  constructor() {
    // terminal:false + a manual line queue: buffered lines (piped/scripted
    // input that arrives all at once) are captured instead of fired into the
    // void between questions. The TTY's own cooked-mode echo handles typing.
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    this.rl.on('line', (line) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w(line);
      } else {
        this.queue.push(line);
      }
    });
    this.rl.on('close', () => {
      this.closed = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w(null); // EOF → caller takes its default
      }
    });
  }

  private nextLine(): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Free-text question; empty input or EOF → default. */
  async ask(question: string, def: string): Promise<string> {
    process.stdout.write(`${theme.brand('?')} ${question} ${theme.dim(`(${def})`)} `);
    const line = await this.nextLine();
    if (line === null) {
      process.stdout.write('\n');
      return def;
    }
    return line.trim() || def;
  }

  /** Numbered single-choice; accepts the number or the value name. */
  async choose<T extends string>(
    prompt: string,
    items: { value: T; label: string; hint?: string }[],
    def: T
  ): Promise<T> {
    const defIdx = Math.max(
      0,
      items.findIndex((i) => i.value === def)
    );
    const list = items
      .map((it, i) => {
        const mark = i === defIdx ? theme.brand('›') : ' ';
        const hint = it.hint ? theme.dim(` — ${it.hint}`) : '';
        return `    ${mark} ${i + 1}) ${it.label}${hint}`;
      })
      .join('\n');
    process.stdout.write(`\n${theme.step.bold(prompt)}\n${list}\n`);
    const raw = await this.ask('Choose', String(defIdx + 1));
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= items.length) return items[n - 1].value;
    const byName = items.find((i) => i.value === raw.toLowerCase());
    return byName ? byName.value : def;
  }

  close(): void {
    if (!this.closed) this.rl.close();
  }
}

/** Free-text question via a one-off readline (TTY path); EOF → default, no hang. */
function textPrompt(question: string, def: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (v: string) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.question(`${theme.brand('?')} ${question} ${theme.dim(`(${def})`)} `, (a) =>
      finish(a.trim() || def)
    );
    rl.on('close', () => finish(def));
  });
}

const PLATFORM_ITEMS: PickerItem<Platform>[] = [
  { value: 'android', label: 'Android', hint: 'emulator or device' },
  { value: 'ios', label: 'iOS', hint: 'simulator or device' },
];
const PROVIDER_ITEMS: PickerItem<Provider>[] = PROVIDERS.map((p) => ({
  value: p.value,
  label: p.label,
  hint: DEFAULT_MODELS[p.value],
}));
const MODE_ITEMS: PickerItem<AgentMode>[] = [
  { value: 'dom', label: 'DOM', hint: 'fast, cheap — reads the UI tree' },
  { value: 'vision', label: 'Vision', hint: 'screenshot + AI — for canvas/games' },
];

async function gatherChoices(parsed: ParsedArgs): Promise<InitChoices> {
  if (parsed.yes) {
    return {
      dir: parsed.dir ?? '.',
      platform: parsed.platform ?? 'android',
      provider: parsed.provider ?? 'gemini',
      agentMode: 'dom',
    };
  }

  // Raw TTY → arrow-key pickers (each picker manages its own keypress stream, so
  // the directory uses a one-off readline that fully closes before they run).
  if (process.stdin.isTTY === true) {
    const dir = parsed.dir ?? (await textPrompt('Project directory', '.'));
    const platform =
      parsed.platform ??
      (await interactivePicker<Platform>(PLATFORM_ITEMS, {
        prompt: 'Which platform do you test? (↑/↓, Enter)',
        searchable: false,
      }));
    const provider =
      parsed.provider ??
      (await interactivePicker<Provider>(PROVIDER_ITEMS, {
        prompt: 'Which LLM provider? (↑/↓, Enter)',
        searchable: false,
      }));
    const agentMode = await interactivePicker<AgentMode>(MODE_ITEMS, {
      prompt: 'Default agent mode? (↑/↓, Enter)',
      searchable: false,
    });
    return { dir, platform, provider, agentMode };
  }

  // Non-TTY (piped / some IDE terminals) → one shared readline, numbered prompts.
  const p = new Prompter();
  try {
    const dir = parsed.dir ?? (await p.ask('Project directory', '.'));
    const platform =
      parsed.platform ??
      (await p.choose<Platform>('Which platform do you test?', PLATFORM_ITEMS, 'android'));
    const provider =
      parsed.provider ??
      (await p.choose<Provider>('Which LLM provider?', PROVIDER_ITEMS, 'gemini'));
    const agentMode = await p.choose<AgentMode>('Default agent mode?', MODE_ITEMS, 'dom');
    return { dir, platform, provider, agentMode };
  } finally {
    p.close();
  }
}

/* ───────────────────────── templates ───────────────────────────── */

function envTemplate(c: InitChoices): string {
  const isOllama = c.provider === 'ollama';
  const keyLine = isOllama
    ? '# Ollama runs locally — no API key needed.\n#LLM_API_KEY='
    : 'LLM_API_KEY=                           # ← paste your key here';

  // A full starter .env: the values you chose are active; everything else is
  // commented with its default so you can discover and tweak it. See the docs
  // for the complete reference.
  return `# ─────────────────────────────────────────────────────────────
#  AppClaw configuration  ·  values you chose are active; the rest
#  are commented with their defaults — uncomment to change.
# ─────────────────────────────────────────────────────────────

# ── LLM ──────────────────────────────────────────────────────
LLM_PROVIDER=${c.provider}              # anthropic | openai | gemini | groq | ollama
${keyLine}
LLM_MODEL=${DEFAULT_MODELS[c.provider]}
#LLM_THINKING=on                        # on | off — extended reasoning (anthropic/gemini/openai)
#LLM_THINKING_BUDGET=128                # Gemini 2.5 / Anthropic thinking-token budget
#LLM_GEMINI_THINKING_LEVEL=medium       # Gemini 3.x reasoning depth: minimal | low | medium | high
#LLM_REQUEST_TIMEOUT_MS=60000           # abort an LLM call after N ms (0 = never)
${
  isOllama
    ? '#OLLAMA_BASE_URL=http://127.0.0.1:11434  # remote/Docker Ollama\n#OLLAMA_API_KEY=                          # Ollama Cloud bearer token\n'
    : ''
}
# ── MCP transport ────────────────────────────────────────────
#MCP_TRANSPORT=stdio                    # stdio | sse
#MCP_HOST=localhost                     # for SSE transport
#MCP_PORT=8080                          # for SSE transport

# ── Agent behaviour ──────────────────────────────────────────
AGENT_MODE=${c.agentMode}               # dom (fast) | vision (screenshot + AI)
#MAX_STEPS=30                           # safety cap on agent steps per goal
#STEP_DELAY=500                         # ms to wait between steps for the UI to settle
#MAX_ELEMENTS=40                        # max UI elements sent to the LLM
#WAIT_TIMEOUT=10000                     # implicit wait for elements (ms; 0 = fail-fast)
#WAIT_INTERVAL=300                      # poll cadence for the implicit wait (ms)
#VISION_MODE=fallback                   # always | fallback | never

# ── Vision (only when AGENT_MODE=vision or VISION_MODE≠never) ─
#GEMINI_API_KEY=                        # only if LLM_PROVIDER≠gemini and using vision
#LLM_SCREENSHOT_MAX_EDGE_PX=0           # downscale screenshots to the LLM (384 / 768); 0 = off

# ── Android MJPEG screenshots (UiAutomator2) ─────────────────
#APPIUM_MJPEG_SERVER_PORT=7810          # 0 disables MJPEG, falls back to normal screenshots
#APPIUM_MJPEG_SCREENSHOT_URL=http://127.0.0.1:7810

# ── Diagnostics ──────────────────────────────────────────────
#SHOW_TOKEN_USAGE=false                 # print per-step token counts + est. cost
#MCP_DEBUG=false                        # verbose appium-mcp logs
#LOCATOR_CACHE_ENABLED=off              # cache resolved DOM locators across runs

# ── Cloud devices (LambdaTest) — uncomment to run on the cloud ─
#CLOUD_PROVIDER=lambdatest
#LAMBDATEST_USERNAME=
#LAMBDATEST_ACCESS_KEY=
#LAMBDATEST_DEVICE_NAME=Samsung Galaxy S24
#LAMBDATEST_OS_VERSION=14
#LAMBDATEST_APP=lt://APP...             # the app to install on the cloud device
`;
}

/** An (essentially empty) .env for the user's real secrets — points at the reference. */
function emptyEnvTemplate(): string {
  return `# Your local config & secrets (gitignored).
# Copy what you need from .env.example, then set LLM_API_KEY here.
`;
}

function configTemplate(c: InitChoices): string {
  return `import { defineConfig, TestContext } from 'appclaw/runner';

/**
 * AppClaw Test Runner config. Every lifecycle hook is included below as a
 * starting point — keep what you need, delete the rest. Hooks run in this order:
 *
 *   globalSetup            once per run (control plane) → returns ctx.state
 *     deviceSetup          once per device, before its first test
 *       beforeEach         around every test
 *         <your test>
 *       afterEach          around every test
 *   globalTeardown         once per run, at the very end
 */
export default defineConfig({
  testDir: 'tests',
  concurrency: 'auto', // one worker per connected device
  retries: 1,
  video: true, // record each test; shown in the HTML report
  node: { local: true }, // spawn a local appium-mcp SSE server

  // ── AppClaw options forwarded to every test's session ──
  platform: '${c.platform}',
  provider: process.env.LLM_PROVIDER as any,
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL,
  agentMode: '${c.agentMode}',
  // capabilitiesFile: './tests/caps.json', // pin appium caps (build path, udid…)
  // maxSteps: 40,
  // waitTimeout: 15000,

  // ── run-scoped: once per run, in the control plane ──
  globalSetup: async ({ pool }) => {
    console.log(\`[globalSetup] \${pool.length} device(s) available\`);
    // Provision shared backend state, seed data, etc. The returned object is
    // injected into every test as \`ctx.state\`.
    return { startedAt: Date.now() };
  },
  globalTeardown: async ({ state }) => {
    console.log(\`[globalTeardown] run took \${Date.now() - state.startedAt}ms\`);
  },

  // ── device-scoped: once per device, before its first test ──
  deviceSetup: async (app, ctx: TestContext) => {
    console.log(\`[deviceSetup] preparing \${ctx.device.name}\`);
    // e.g. install the build / grant permissions — state persists for the device.
  },

  // ── test-scoped: around every test ──
  beforeEach: async (app, ctx: TestContext) => {
    console.log(\`[beforeEach] \${ctx.title} on \${ctx.device.name}\`);
  },
  afterEach: async (app, info) => {
    console.log(\`[afterEach] \${info.title} → \${info.status} (\${info.durationMs}ms)\`);
  },
});
`;
}

function specTemplate(): string {
  return `import { test, describe } from 'appclaw/runner';

describe('Example', () => {
  // Each test gets a fresh \`app\` on a leased device. Describe what you want in
  // plain English — AppClaw drives the device for you.
  test('the app opens to its home screen', async ({ app }) => {
    await app.verify('the app is open');

    // Drive it further (uncomment + adapt to your app):
    // await app.run('tap the Search field');
    // await app.run('type hello world');
    // await app.verify('search results are visible');
  });

  // Restrict a test to one platform — skipped (not failed) on the other OS:
  // test.android('android-only feature', async ({ app }) => { … });
  // test.ios('ios-only feature', async ({ app }) => { … });
});
`;
}

function gitignoreEntries(): string[] {
  return ['node_modules/', '.appclaw/', '.env'];
}

function tsconfigTemplate(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['tests', 'appclaw.config.ts'],
    },
    null,
    2
  )}\n`;
}

/* ───────────────────────── file writing ────────────────────────── */

interface WriteResult {
  rel: string;
  status: 'created' | 'merged' | 'skipped';
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write a file, skipping it if present (unless force). */
function writeFile(
  abs: string,
  rel: string,
  content: string,
  force: boolean,
  results: WriteResult[]
): void {
  if (fs.existsSync(abs) && !force) {
    results.push({ rel, status: 'skipped' });
    return;
  }
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content, 'utf-8');
  results.push({ rel, status: 'created' });
}

/** Merge .gitignore — append only the entries that aren't already present. */
function mergeGitignore(abs: string, rel: string, results: WriteResult[]): void {
  const wanted = gitignoreEntries();
  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, wanted.join('\n') + '\n', 'utf-8');
    results.push({ rel, status: 'created' });
    return;
  }
  const existing = fs.readFileSync(abs, 'utf-8');
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((w) => !lines.has(w));
  if (missing.length === 0) {
    results.push({ rel, status: 'skipped' });
    return;
  }
  const sep = existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(abs, `${sep}${missing.join('\n')}\n`, 'utf-8');
  results.push({ rel, status: 'merged' });
}

/** Create or merge package.json — adds scripts + devDeps without clobbering. */
function mergePackageJson(abs: string, rel: string, dirName: string, results: WriteResult[]): void {
  const scripts = {
    test: 'appclaw test --env-file .env',
    'test:parallel': 'appclaw test --workers 3 --env-file .env',
  };
  const devDeps = { appclaw: `^${MIN_APPCLAW_VERSION}`, tsx: '^4.21.0' };

  if (!fs.existsSync(abs)) {
    const pkg = {
      name: dirName.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'appclaw-tests',
      private: true,
      type: 'module',
      scripts,
      devDependencies: devDeps,
    };
    fs.writeFileSync(abs, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    results.push({ rel, status: 'created' });
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  if (pkg.type !== 'module') pkg.type = 'module';
  pkg.scripts = { ...scripts, ...(pkg.scripts ?? {}) }; // keep user's existing scripts
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}) };
  if (!pkg.devDependencies.appclaw) pkg.devDependencies.appclaw = devDeps.appclaw;
  if (!pkg.devDependencies.tsx) pkg.devDependencies.tsx = devDeps.tsx;
  fs.writeFileSync(abs, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  results.push({ rel, status: 'merged' });
}

/* ───────────────────────── orchestration ───────────────────────── */

function printHelp(): void {
  process.stdout.write(
    `${theme.brand('appclaw init')} — scaffold a Test Runner project\n\n` +
      `Usage:\n  appclaw init [dir] [options]\n\n` +
      `Options:\n` +
      `  --platform <android|ios>   Preselect the platform\n` +
      `  --provider <p>             Preselect the LLM provider\n` +
      `  -y, --yes                  Use defaults, no prompts\n` +
      `  -f, --force                Overwrite existing files\n` +
      `  -h, --help                 Show this help\n`
  );
}

export async function runInit(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printHelp();
    return 0;
  }

  process.stdout.write(`\n  ${theme.brand('◐')} ${theme.step.bold('AppClaw')} project setup\n\n`);

  const choices = await gatherChoices(parsed);
  const root = path.resolve(process.cwd(), choices.dir);
  const dirName = path.basename(root);
  ensureDir(root);

  const results: WriteResult[] = [];
  // Full reference template (committed) + an empty .env for real secrets (gitignored).
  writeFile(
    path.join(root, '.env.example'),
    '.env.example',
    envTemplate(choices),
    parsed.force,
    results
  );
  writeFile(path.join(root, '.env'), '.env', emptyEnvTemplate(), parsed.force, results);
  writeFile(
    path.join(root, 'appclaw.config.ts'),
    'appclaw.config.ts',
    configTemplate(choices),
    parsed.force,
    results
  );
  writeFile(
    path.join(root, 'tests', 'example.spec.ts'),
    'tests/example.spec.ts',
    specTemplate(),
    parsed.force,
    results
  );
  writeFile(
    path.join(root, 'tsconfig.json'),
    'tsconfig.json',
    tsconfigTemplate(),
    parsed.force,
    results
  );
  mergePackageJson(path.join(root, 'package.json'), 'package.json', dirName, results);
  mergeGitignore(path.join(root, '.gitignore'), '.gitignore', results);

  // ── summary ──
  process.stdout.write(`\n  ${theme.brand('✓')} Scaffolded into ${theme.step.bold(root)}\n\n`);
  for (const r of results) {
    const mark =
      r.status === 'created'
        ? theme.brand('＋ created')
        : r.status === 'merged'
          ? theme.info('↻ merged ')
          : theme.dim('• skipped');
    process.stdout.write(`    ${mark}  ${r.rel}\n`);
  }
  if (results.some((r) => r.status === 'skipped')) {
    process.stdout.write(
      `\n  ${theme.dim('Some files already existed — re-run with --force to overwrite.')}\n`
    );
  }

  // ── next steps ──
  const cdStep = choices.dir === '.' ? '' : `cd ${choices.dir} && `;
  const keyStep =
    choices.provider === 'ollama'
      ? `${theme.dim('(Ollama is local — no API key needed)')}`
      : `copy values from ${theme.step.bold('.env.example')} into ${theme.step.bold('.env')} and set ${theme.step.bold('LLM_API_KEY')}`;
  process.stdout.write(
    `\n  ${theme.step.bold('Next steps')}\n` +
      `    1. ${cdStep}npm install\n` +
      `    2. ${keyStep}\n` +
      `    3. start an emulator / simulator (or connect a device)\n` +
      `    4. ${theme.brand('npm test')}\n\n`
  );
  return 0;
}
