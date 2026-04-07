import { describe, test, expect, vi } from 'vitest';
import { emptyBindings, type VariableBindings } from '../../src/flow/variable-resolver.js';

// Mock the LLM parser so tests don't require an API key
vi.mock('../../src/flow/llm-parser.js', () => ({
  resolveNaturalStep: async (instruction: string) => ({
    kind: 'tap',
    label: instruction,
    verbatim: instruction,
  }),
}));

const { parseFlowYamlString } = await import('../../src/flow/parse-yaml-flow.js');

// ── Flat format (legacy) ────────────────────────────────────────────

describe('parseFlowYamlString — flat format', () => {
  test('parses a simple flat step list', async () => {
    const yaml = `- tap Login\n- wait 2s\n- done`;
    const result = await parseFlowYamlString(yaml);
    expect(result.steps.length).toBe(3);
    expect(result.steps[0].kind).toBe('tap');
    expect(result.phases.length).toBe(3);
    // All flat steps default to "test" phase
    expect(result.phases.every((p) => p.phase === 'test')).toBe(true);
  });

  test('parses two-document format (meta --- steps)', async () => {
    const yaml = `platform: android\nappId: com.test\n---\n- open Settings\n- done`;
    const result = await parseFlowYamlString(yaml);
    expect(result.meta.platform).toBe('android');
    expect(result.meta.appId).toBe('com.test');
    expect(result.steps.length).toBe(2);
  });

  test('parses single-document with steps key', async () => {
    const yaml = `name: test\nplatform: ios\nsteps:\n  - tap Login\n  - done`;
    // This has `steps` key but no setup/assertions, so it's still "flat" via extractPhasedOrFlat
    // Actually it will detect "steps" as a phase key. Let's check:
    const result = await parseFlowYamlString(yaml);
    expect(result.meta.name).toBe('test');
    expect(result.steps.length).toBe(2);
  });
});

// ── Phased format ───────────────────────────────────────────────────

describe('parseFlowYamlString — phased format', () => {
  test('parses setup + steps + assertions', async () => {
    const yaml = [
      'name: login_test',
      '---',
      'setup:',
      '  - open MyApp',
      'steps:',
      '  - tap Login',
      "  - type 'user@test.com'",
      'assertions:',
      '  - verify Dashboard is visible',
    ].join('\n');

    const result = await parseFlowYamlString(yaml);

    expect(result.meta.name).toBe('login_test');

    // Check phase distribution
    const setupPhases = result.phases.filter((p) => p.phase === 'setup');
    const testPhases = result.phases.filter((p) => p.phase === 'test');
    const assertPhases = result.phases.filter((p) => p.phase === 'assertion');

    expect(setupPhases.length).toBe(1);
    expect(testPhases.length).toBe(2);
    expect(assertPhases.length).toBe(1);

    // Setup step
    expect(setupPhases[0].step.kind).toBe('openApp');

    // Assertion step
    expect(assertPhases[0].step.kind).toBe('assert');
  });

  test('works with only steps and assertions (no setup)', async () => {
    const yaml = ['steps:', '  - tap Login', 'assertions:', '  - assert Success is visible'].join(
      '\n'
    );

    const result = await parseFlowYamlString(yaml);
    const setupPhases = result.phases.filter((p) => p.phase === 'setup');
    const testPhases = result.phases.filter((p) => p.phase === 'test');
    const assertPhases = result.phases.filter((p) => p.phase === 'assertion');

    expect(setupPhases.length).toBe(0);
    expect(testPhases.length).toBe(1);
    expect(assertPhases.length).toBe(1);
  });

  test('works with only setup and steps (no assertions)', async () => {
    const yaml = ['setup:', '  - open Settings', 'steps:', '  - tap WiFi'].join('\n');

    const result = await parseFlowYamlString(yaml);
    expect(result.phases.filter((p) => p.phase === 'setup').length).toBe(1);
    expect(result.phases.filter((p) => p.phase === 'test').length).toBe(1);
    expect(result.phases.filter((p) => p.phase === 'assertion').length).toBe(0);
  });

  test('total steps equals sum of all phases', async () => {
    const yaml = [
      'setup:',
      '  - open App',
      '  - wait 2s',
      'steps:',
      '  - tap A',
      '  - tap B',
      '  - tap C',
      'assertions:',
      '  - assert X is visible',
    ].join('\n');

    const result = await parseFlowYamlString(yaml);
    expect(result.steps.length).toBe(6);
    expect(result.phases.length).toBe(6);
  });
});

// ── Variable interpolation ──────────────────────────────────────────

describe('parseFlowYamlString — variable interpolation', () => {
  // Secrets are resolved from process.env, not from bindings
  const bindings: VariableBindings = {
    variables: { appName: 'MyApp' },
  };

  test('interpolates variables in flat steps', async () => {
    const yaml = `- open \${variables.appName}\n- done`;
    const result = await parseFlowYamlString(yaml, { bindings });
    expect(result.steps[0].kind).toBe('openApp');
    if (result.steps[0].kind === 'openApp') {
      expect(result.steps[0].query).toBe('MyApp');
    }
  });

  test('interpolates secrets in type steps', async () => {
    process.env.email = 'user@test.com';
    try {
      const yaml = `- type '\${secrets.email}'\n- done`;
      const result = await parseFlowYamlString(yaml, { bindings });
      expect(result.steps[0].kind).toBe('type');
      if (result.steps[0].kind === 'type') {
        expect(result.steps[0].text).toBe('user@test.com');
      }
    } finally {
      delete process.env.email;
    }
  });

  test('interpolates in phased format', async () => {
    process.env.email = 'user@test.com';
    try {
      const yaml = [
        'setup:',
        '  - open ${variables.appName}',
        'steps:',
        "  - type '${secrets.email}'",
        'assertions:',
        '  - assert Dashboard is visible',
      ].join('\n');

      const result = await parseFlowYamlString(yaml, { bindings });
      const setupStep = result.phases.find((p) => p.phase === 'setup')?.step;
      expect(setupStep?.kind).toBe('openApp');
      if (setupStep?.kind === 'openApp') {
        expect(setupStep.query).toBe('MyApp');
      }
    } finally {
      delete process.env.email;
    }
  });

  test('works without bindings (no interpolation)', async () => {
    const yaml = `- tap Login\n- done`;
    const result = await parseFlowYamlString(yaml);
    expect(result.steps[0].kind).toBe('tap');
  });
});

// ── Meta extraction ─────────────────────────────────────────────────

describe('parseFlowYamlString — meta extraction', () => {
  test('extracts description from meta', async () => {
    const yaml = [
      'name: test_flow',
      'description: Verifies login works',
      'platform: ios',
      '---',
      '- tap Login',
    ].join('\n');

    const result = await parseFlowYamlString(yaml);
    expect(result.meta.name).toBe('test_flow');
    expect(result.meta.description).toBe('Verifies login works');
    expect(result.meta.platform).toBe('ios');
  });

  test('extracts env name from meta', async () => {
    const yaml = ['name: test', 'env: staging', '---', '- tap Login'].join('\n');

    const result = await parseFlowYamlString(yaml);
    expect(result.meta.env).toBe('staging');
  });
});

// ── Error handling ──────────────────────────────────────────────────

describe('parseFlowYamlString — errors', () => {
  test('throws on empty YAML', async () => {
    await expect(parseFlowYamlString('')).rejects.toThrow('Empty YAML');
  });

  test('throws on invalid YAML syntax', async () => {
    await expect(parseFlowYamlString('- [unclosed')).rejects.toThrow();
  });
});
