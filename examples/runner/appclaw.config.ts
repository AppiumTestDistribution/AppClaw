import { defineConfig, TestContext } from 'appclaw/runner';

export default defineConfig({
  video: true,
  testDir: 'tests',
  concurrency: 'auto',
  retries: 1,
  node: { local: true }, // spawn a local appium-mcp SSE server url: 'http://localhost:8080'

  // ── AppClaw options (forwarded to every test's session) ──
  platform: 'android',
  provider: process.env.LLM_PROVIDER as any,
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL,
  capabilitiesFile: process.env.APPCLAW_CAPS ?? './tests/caps.json', // resolved relative to this config file (CI overrides via APPCLAW_CAPS)
  // any other AppClawOptions also work here, e.g.:
  // agentMode: 'vision', maxSteps: 40, waitTimeout: 15000, video: true,

  // ── run-scoped (once per run, in the control plane) ──
  globalSetup: async ({ pool }) => {
    console.log(`[globalSetup] pool has ${pool.length} device(s)`);
    return { startedAt: Date.now(), seededUser: 'admin' }; // injected into every test as ctx.state
  },
  globalTeardown: async ({ state }) => {
    console.log(`[globalTeardown] run took ${Date.now() - state.startedAt}ms`);
  },

  // ── device-scoped (once per device, before its first test) ──
  deviceSetup: async (app, ctx: TestContext) => {
    console.log(`[deviceSetup] preparing ${ctx.device.name}`);
    // e.g. install build / grant permissions — runs once, state persists on device
  },

  // ── test-scoped (around every test) ──
  beforeEach: async (app, ctx) => {
    console.log(
      `[beforeEach] "${ctx.title}" on ${ctx.device.name} (state.user=${ctx.state.seededUser})`
    );
  },
  afterEach: async (app, info) => {
    console.log(`[afterEach] "${info.title}" → ${info.status} in ${info.durationMs}ms`);
  },
});
