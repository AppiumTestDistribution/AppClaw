import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { VariableBindings } from '../../src/flow/variable-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock the LLM parser so tests don't require an API key
vi.mock('../../src/flow/llm-parser.js', () => ({
  resolveNaturalStep: async (instruction: string) => ({
    kind: 'tap',
    label: instruction,
    verbatim: instruction,
  }),
}));

const { parseFlowYamlString } = await import('../../src/flow/parse-yaml-flow.js');

const FIXTURES = resolve(__dirname, '../flows/fixtures');

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf-8');
}

// ── Flat format fixtures ────────────────────────────────────────────

describe('YAML fixtures: flat-simple.yaml', () => {
  test('parses 3 natural language steps', async () => {
    const result = await parseFlowYamlString(readFixture('flat-simple.yaml'));
    expect(result.steps.length).toBe(3);
    expect(result.steps[0].kind).toBe('openApp');
    expect(result.steps[1].kind).toBe('tap');
    expect(result.steps[2].kind).toBe('done');
  });

  test('all steps are test phase', async () => {
    const result = await parseFlowYamlString(readFixture('flat-simple.yaml'));
    expect(result.phases.every((p) => p.phase === 'test')).toBe(true);
  });

  test('no meta extracted', async () => {
    const result = await parseFlowYamlString(readFixture('flat-simple.yaml'));
    expect(result.meta.platform).toBeUndefined();
    expect(result.meta.name).toBeUndefined();
  });
});

describe('YAML fixtures: flat-with-meta.yaml', () => {
  test('extracts platform and appId from meta', async () => {
    const result = await parseFlowYamlString(readFixture('flat-with-meta.yaml'));
    expect(result.meta.platform).toBe('android');
    expect(result.meta.appId).toBe('com.android.settings');
    expect(result.meta.name).toBe('WiFi Toggle');
  });

  test('parses structured key steps (tap: value)', async () => {
    const result = await parseFlowYamlString(readFixture('flat-with-meta.yaml'));
    expect(result.steps[0].kind).toBe('launchApp');
    expect(result.steps[1].kind).toBe('wait');
    expect(result.steps[2].kind).toBe('tap');
    expect(result.steps[3].kind).toBe('done');
    if (result.steps[2].kind === 'tap') {
      expect(result.steps[2].label).toBe('WiFi');
    }
    if (result.steps[3].kind === 'done') {
      expect(result.steps[3].message).toBe('WiFi toggled');
    }
  });
});

describe('YAML fixtures: flat-natural-language.yaml', () => {
  test('parses natural language steps correctly', async () => {
    const result = await parseFlowYamlString(readFixture('flat-natural-language.yaml'));
    expect(result.meta.name).toBe('Natural Language Demo');
    expect(result.steps.length).toBe(7);
    expect(result.steps[0].kind).toBe('openApp');
    expect(result.steps[1].kind).toBe('tap'); // click on Search Button
    expect(result.steps[2].kind).toBe('type'); // type 'Appium 3.0'
    expect(result.steps[3].kind).toBe('wait'); // wait 3 seconds
    expect(result.steps[4].kind).toBe('swipe'); // scroll down 2 times
    expect(result.steps[5].kind).toBe('assert'); // verify video is visible
    expect(result.steps[6].kind).toBe('done');
  });

  test('wait has correct seconds', async () => {
    const result = await parseFlowYamlString(readFixture('flat-natural-language.yaml'));
    const wait = result.steps[3];
    expect(wait.kind).toBe('wait');
    if (wait.kind === 'wait') expect(wait.seconds).toBe(3);
  });

  test('scroll has correct repeat count', async () => {
    const result = await parseFlowYamlString(readFixture('flat-natural-language.yaml'));
    const scroll = result.steps[4];
    expect(scroll.kind).toBe('swipe');
    if (scroll.kind === 'swipe') {
      expect(scroll.direction).toBe('down');
      expect(scroll.repeat).toBe(2);
    }
  });
});

// ── Phased format fixtures ──────────────────────────────────────────

describe('YAML fixtures: phased-full.yaml', () => {
  test('parses all three phases', async () => {
    const result = await parseFlowYamlString(readFixture('phased-full.yaml'));
    const setup = result.phases.filter((p) => p.phase === 'setup');
    const steps = result.phases.filter((p) => p.phase === 'test');
    const asserts = result.phases.filter((p) => p.phase === 'assertion');

    expect(setup.length).toBe(2);
    // 6 test steps: tap Email, type email, tap Password, type password, tap Login, wait 5s
    expect(steps.length).toBe(6);
    expect(asserts.length).toBe(2);
  });

  test('extracts full meta', async () => {
    const result = await parseFlowYamlString(readFixture('phased-full.yaml'));
    expect(result.meta.name).toBe('Login Test');
    expect(result.meta.description).toBe('Tests the login flow end to end');
    expect(result.meta.platform).toBe('ios');
  });

  test('total steps equals sum of phases', async () => {
    const result = await parseFlowYamlString(readFixture('phased-full.yaml'));
    expect(result.steps.length).toBe(result.phases.length);
    expect(result.steps.length).toBe(10);
  });

  test('setup steps are correct kinds', async () => {
    const result = await parseFlowYamlString(readFixture('phased-full.yaml'));
    const setup = result.phases.filter((p) => p.phase === 'setup');
    expect(setup[0].step.kind).toBe('openApp');
    expect(setup[1].step.kind).toBe('waitUntil');
  });

  test('assertion steps are assert kind', async () => {
    const result = await parseFlowYamlString(readFixture('phased-full.yaml'));
    const asserts = result.phases.filter((p) => p.phase === 'assertion');
    expect(asserts[0].step.kind).toBe('assert');
    expect(asserts[1].step.kind).toBe('assert');
  });
});

describe('YAML fixtures: phased-partial.yaml', () => {
  test('no setup phase, only steps and assertions', async () => {
    const result = await parseFlowYamlString(readFixture('phased-partial.yaml'));
    const setup = result.phases.filter((p) => p.phase === 'setup');
    const steps = result.phases.filter((p) => p.phase === 'test');
    const asserts = result.phases.filter((p) => p.phase === 'assertion');

    expect(setup.length).toBe(0);
    expect(steps.length).toBe(3);
    expect(asserts.length).toBe(1);
  });
});

describe('YAML fixtures: phased-with-variables.yaml', () => {
  // Secrets are resolved from process.env, not from bindings
  const bindings: VariableBindings = {
    variables: { app_name: 'MyTestApp', welcome_text: 'Welcome back!' },
  };

  test('interpolates variables in openApp step', async () => {
    // Set required secrets in process.env for this test
    process.env.email = 'test@example.com';
    process.env.password = 's3cret';
    try {
      const result = await parseFlowYamlString(readFixture('phased-with-variables.yaml'), {
        bindings,
      });
      const setup = result.phases.filter((p) => p.phase === 'setup');
      expect(setup[0].step.kind).toBe('openApp');
      if (setup[0].step.kind === 'openApp') {
        expect(setup[0].step.query).toBe('MyTestApp');
      }
    } finally {
      delete process.env.email;
      delete process.env.password;
    }
  });

  test('interpolates secrets from process.env in type steps', async () => {
    process.env.email = 'test@example.com';
    process.env.password = 's3cret';
    try {
      const result = await parseFlowYamlString(readFixture('phased-with-variables.yaml'), {
        bindings,
      });
      const typeSteps = result.phases.filter((p) => p.step.kind === 'type');
      expect(typeSteps.length).toBe(2);
      if (typeSteps[0].step.kind === 'type') {
        expect(typeSteps[0].step.text).toBe('test@example.com');
      }
      if (typeSteps[1].step.kind === 'type') {
        expect(typeSteps[1].step.text).toBe('s3cret');
      }
    } finally {
      delete process.env.email;
      delete process.env.password;
    }
  });

  test('interpolates variables in assertion text', async () => {
    process.env.email = 'test@example.com';
    process.env.password = 's3cret';
    try {
      const result = await parseFlowYamlString(readFixture('phased-with-variables.yaml'), {
        bindings,
      });
      const asserts = result.phases.filter((p) => p.phase === 'assertion');
      expect(asserts[0].step.kind).toBe('assert');
      if (asserts[0].step.kind === 'assert') {
        expect(asserts[0].step.text).toBe('Welcome back!');
      }
    } finally {
      delete process.env.email;
      delete process.env.password;
    }
  });

  test('extracts env meta', async () => {
    process.env.email = 'test@example.com';
    process.env.password = 's3cret';
    try {
      const result = await parseFlowYamlString(readFixture('phased-with-variables.yaml'), {
        bindings,
      });
      expect(result.meta.env).toBe('dev');
    } finally {
      delete process.env.email;
      delete process.env.password;
    }
  });
});

// ── Structured keys ─────────────────────────────────────────────────

describe('YAML fixtures: structured-keys.yaml', () => {
  test('parses structured key:value steps', async () => {
    const result = await parseFlowYamlString(readFixture('structured-keys.yaml'));
    expect(result.meta.appId).toBe('com.example.app');
    expect(result.steps.length).toBe(5);
    expect(result.steps[0].kind).toBe('launchApp');
    expect(result.steps[1].kind).toBe('wait');
    expect(result.steps[2].kind).toBe('tap');
    expect(result.steps[3].kind).toBe('type');
    expect(result.steps[4].kind).toBe('done');
  });

  test('wait has correct seconds', async () => {
    const result = await parseFlowYamlString(readFixture('structured-keys.yaml'));
    if (result.steps[1].kind === 'wait') {
      expect(result.steps[1].seconds).toBe(3);
    }
  });

  test('done has message', async () => {
    const result = await parseFlowYamlString(readFixture('structured-keys.yaml'));
    const last = result.steps[result.steps.length - 1];
    expect(last.kind).toBe('done');
    if (last.kind === 'done') expect(last.message).toBe('Login complete');
  });
});

// ── Mixed format ────────────────────────────────────────────────────

describe('YAML fixtures: mixed-natural-structured.yaml', () => {
  test('handles mix of structured and natural language', async () => {
    const result = await parseFlowYamlString(readFixture('mixed-natural-structured.yaml'));
    expect(result.meta.name).toBe('Mixed Format');
    expect(result.meta.platform).toBe('android');

    expect(result.steps[0].kind).toBe('launchApp'); // launchApp (string)
    expect(result.steps[1].kind).toBe('wait'); // wait: 2 (structured)
    expect(result.steps[2].kind).toBe('tap'); // click on Login button (NL)
    expect(result.steps[3].kind).toBe('type'); // type 'hello@world.com' in email field (NL)
    expect(result.steps[4].kind).toBe('tap'); // tap: "Submit" (structured)
    expect(result.steps[5].kind).toBe('wait'); // wait 3s (NL)
    expect(result.steps[6].kind).toBe('assert'); // verify Dashboard is visible (NL)
    expect(result.steps[7].kind).toBe('done'); // done (NL)
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe('YAML fixtures: edge-cases.yaml', () => {
  test('parses all edge case steps without throwing', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps.length).toBe(14);
  });

  test('bare wait defaults to 2 seconds', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[0].kind).toBe('wait');
    if (result.steps[0].kind === 'wait') expect(result.steps[0].seconds).toBe(2);
  });

  test('wait a moment defaults to 2 seconds', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[1].kind).toBe('wait');
    if (result.steps[1].kind === 'wait') expect(result.steps[1].seconds).toBe(2);
  });

  test('go back → back', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[2].kind).toBe('back');
  });

  test('go home → home', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[3].kind).toBe('home');
  });

  test('press enter → tap (note: press regex matches before enter regex)', async () => {
    // "press enter" is caught by the `press` pattern before the `enter` pattern
    // This means it becomes tap: "enter" instead of kind: "enter"
    // The standalone enterMatch regex does handle "press enter" but pressMatch runs first
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[4].kind).toBe('tap');
  });

  test('submit → enter', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[5].kind).toBe('enter');
  });

  test('swipe up 5 times has repeat=5', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[6].kind).toBe('swipe');
    if (result.steps[6].kind === 'swipe') {
      expect(result.steps[6].direction).toBe('up');
      expect(result.steps[6].repeat).toBe(5);
    }
  });

  test('scroll down → swipe down', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[7].kind).toBe('swipe');
    if (result.steps[7].kind === 'swipe') {
      expect(result.steps[7].direction).toBe('down');
    }
  });

  test('search for something → type', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[8].kind).toBe('type');
    if (result.steps[8].kind === 'type') {
      expect(result.steps[8].text).toBe('something');
    }
  });

  test('navigate to Settings → tap', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    expect(result.steps[10].kind).toBe('tap');
    if (result.steps[10].kind === 'tap') {
      expect(result.steps[10].label).toBe('Settings');
    }
  });

  test('scroll down 3 times until Submit is visible → scrollAssert', async () => {
    const result = await parseFlowYamlString(readFixture('edge-cases.yaml'));
    const last = result.steps[result.steps.length - 1];
    expect(last.kind).toBe('scrollAssert');
    if (last.kind === 'scrollAssert') {
      expect(last.text).toBe('Submit');
      expect(last.direction).toBe('down');
      expect(last.maxScrolls).toBe(3);
    }
  });
});

// ── Wait variants ───────────────────────────────────────────────────

describe('YAML fixtures: wait-variants.yaml', () => {
  test('parses all wait variants without throwing', async () => {
    const result = await parseFlowYamlString(readFixture('wait-variants.yaml'));
    expect(result.steps.length).toBe(12);
  });

  test('each variant parses to correct kind', async () => {
    const result = await parseFlowYamlString(readFixture('wait-variants.yaml'));
    const kinds = result.steps.map((s) => s.kind);
    expect(kinds[0]).toBe('wait'); // wait
    expect(kinds[1]).toBe('wait'); // wait 2s
    expect(kinds[2]).toBe('wait'); // wait 5 seconds
    expect(kinds[3]).toBe('wait'); // wait for 3 sec
    expect(kinds[4]).toBe('wait'); // sleep 1s
    expect(kinds[5]).toBe('wait'); // pause 500ms
    expect(kinds[6]).toBe('waitUntil'); // wait until screen is loaded
    expect(kinds[7]).toBe('waitUntil'); // wait until Login is visible
    expect(kinds[8]).toBe('waitUntil'); // wait 10s until Dashboard is visible
    expect(kinds[9]).toBe('waitUntil'); // wait until popup is gone
    expect(kinds[10]).toBe('waitUntil'); // wait until loading is hidden
    expect(kinds[11]).toBe('wait'); // wait a bit
  });
});

// ── Error cases ─────────────────────────────────────────────────────

describe('YAML fixtures: error cases', () => {
  test('empty.yaml throws', async () => {
    await expect(parseFlowYamlString(readFixture('empty.yaml'))).rejects.toThrow();
  });

  test('invalid-syntax.yaml throws', async () => {
    await expect(parseFlowYamlString(readFixture('invalid-syntax.yaml'))).rejects.toThrow();
  });
});

// ── Existing example flows (regression) ─────────────────────────────

describe('YAML regression: existing example flows', () => {
  const EXAMPLES = resolve(__dirname, '../../examples/flows');
  const FLOWS = resolve(__dirname, '../../flows');

  test('google-search.yaml parses (legacy structured)', async () => {
    const content = readFileSync(resolve(EXAMPLES, 'google-search.yaml'), 'utf-8');
    const result = await parseFlowYamlString(content);
    expect(result.meta.appId).toBe('com.vodqareactnative');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].kind).toBe('launchApp');
  });

  test('vodqa-natural.yaml parses (natural language)', async () => {
    const content = readFileSync(resolve(EXAMPLES, 'vodqa-natural.yaml'), 'utf-8');
    const result = await parseFlowYamlString(content);
    expect(result.meta.name).toBe('VodQA — login and vertical swiping demo');
    expect(result.steps[0].kind).toBe('openApp');
    expect(result.steps[result.steps.length - 1].kind).toBe('done');
  });

  test('settings-wifi-on.yaml parses (structured with comments)', async () => {
    const content = readFileSync(resolve(EXAMPLES, 'settings-wifi-on.yaml'), 'utf-8');
    const result = await parseFlowYamlString(content);
    expect(result.meta.appId).toBe('com.android.settings');
    expect(result.steps[0].kind).toBe('launchApp');
  });

  test('youtube-search-appium3.yaml parses (mixed)', async () => {
    const content = readFileSync(resolve(EXAMPLES, 'youtube-search-appium3.yaml'), 'utf-8');
    const result = await parseFlowYamlString(content);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[result.steps.length - 1].kind).toBe('done');
  });

  test('flows/youtube.yaml parses (legacy flat with phases key)', async () => {
    const content = readFileSync(resolve(FLOWS, 'youtube.yaml'), 'utf-8');
    const result = await parseFlowYamlString(content);
    expect(result.meta.platform).toBe('android');
    expect(result.steps.length).toBeGreaterThan(0);
  });

  test('youtube-phased.yaml parses (phased with variables)', async () => {
    const content = readFileSync(resolve(__dirname, '../flows/youtube-phased.yaml'), 'utf-8');
    const bindings: VariableBindings = {
      variables: { app_name: 'YouTube', expected_channel: 'TestMu AI' },
    };
    // Secrets come from process.env
    process.env.search_query = 'Appium 3.0';
    try {
      const result = await parseFlowYamlString(content, { bindings });
      expect(result.meta.name).toBe('YouTube Search');
      expect(result.meta.env).toBe('dev');

      const setup = result.phases.filter((p) => p.phase === 'setup');
      const steps = result.phases.filter((p) => p.phase === 'test');
      const asserts = result.phases.filter((p) => p.phase === 'assertion');

      expect(setup.length).toBe(2);
      expect(steps.length).toBeGreaterThan(0);
      expect(asserts.length).toBe(1);
    } finally {
      delete process.env.search_query;
    }
  });
});
