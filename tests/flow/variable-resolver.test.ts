import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  interpolate,
  hasPlaceholders,
  interpolateStep,
  loadEnvironmentFile,
  loadInlineBindings,
  mergeBindings,
  emptyBindings,
  type VariableBindings,
} from '../../src/flow/variable-resolver.js';

// ── interpolate ─────────────────────────────────────────────────────

describe('interpolate', () => {
  const bindings: VariableBindings = {
    variables: { locale: 'en-US', timeout: 30, debug: true },
  };

  beforeEach(() => {
    process.env.__TEST_EMAIL = 'user@test.com';
    process.env.__TEST_PASSWORD = 's3cret';
  });

  afterEach(() => {
    delete process.env.__TEST_EMAIL;
    delete process.env.__TEST_PASSWORD;
  });

  test('replaces ${variables.X} with variable values', () => {
    const result = interpolate('locale is ${variables.locale}', bindings);
    expect(result.resolved).toBe('locale is en-US');
    expect(result.redacted).toBe('locale is en-US');
  });

  test('replaces ${secrets.X} with process.env values', () => {
    const result = interpolate('email: ${secrets.__TEST_EMAIL}', bindings);
    expect(result.resolved).toBe('email: user@test.com');
  });

  test('redacts secrets in redacted output', () => {
    const result = interpolate(
      'login with ${secrets.__TEST_EMAIL} / ${secrets.__TEST_PASSWORD}',
      bindings
    );
    expect(result.resolved).toBe('login with user@test.com / s3cret');
    expect(result.redacted).toBe('login with *** / ***');
  });

  test('handles numeric variables', () => {
    const result = interpolate('timeout: ${variables.timeout}', bindings);
    expect(result.resolved).toBe('timeout: 30');
  });

  test('handles boolean variables', () => {
    const result = interpolate('debug: ${variables.debug}', bindings);
    expect(result.resolved).toBe('debug: true');
  });

  test('handles multiple placeholders in one string', () => {
    const result = interpolate('${secrets.__TEST_EMAIL} with ${variables.locale}', bindings);
    expect(result.resolved).toBe('user@test.com with en-US');
    expect(result.redacted).toBe('*** with en-US');
  });

  test('returns original string when no placeholders present', () => {
    const result = interpolate('just a plain string', bindings);
    expect(result.resolved).toBe('just a plain string');
    expect(result.redacted).toBe('just a plain string');
  });

  test('throws on undefined secret (missing env var)', () => {
    expect(() => interpolate('${secrets.NONEXISTENT_VAR_XYZ}', bindings)).toThrow(
      'Undefined secret: "${secrets.NONEXISTENT_VAR_XYZ}"'
    );
  });

  test('throws on undefined variable', () => {
    expect(() => interpolate('${variables.missing}', bindings)).toThrow(
      'Undefined variable: "${variables.missing}"'
    );
  });
});

// ── hasPlaceholders ─────────────────────────────────────────────────

describe('hasPlaceholders', () => {
  test('detects secrets placeholder', () => {
    expect(hasPlaceholders('type ${secrets.email}')).toBe(true);
  });

  test('detects variables placeholder', () => {
    expect(hasPlaceholders('wait ${variables.timeout}')).toBe(true);
  });

  test('returns false for plain strings', () => {
    expect(hasPlaceholders('click Login button')).toBe(false);
  });

  test('returns false for non-matching ${} patterns', () => {
    expect(hasPlaceholders('${ENV_VAR}')).toBe(false);
  });
});

// ── interpolateStep ─────────────────────────────────────────────────

describe('interpolateStep', () => {
  const bindings: VariableBindings = {
    variables: { username: 'testuser' },
  };

  beforeEach(() => {
    process.env.__TEST_PASS = 'p4ss';
  });

  afterEach(() => {
    delete process.env.__TEST_PASS;
  });

  test('interpolates string fields in a step object', () => {
    const step = {
      kind: 'type' as const,
      text: '${variables.username}',
      verbatim: 'type "${variables.username}"',
    };
    const result = interpolateStep(step, bindings);
    expect(result.text).toBe('testuser');
  });

  test('redacts secrets in verbatim', () => {
    const step = {
      kind: 'type' as const,
      text: '${secrets.__TEST_PASS}',
      verbatim: 'type "${secrets.__TEST_PASS}"',
    };
    const result = interpolateStep(step, bindings);
    expect(result.text).toBe('p4ss');
    expect(result.verbatim).toBe('type "***"');
  });

  test('returns same object when bindings are empty and no secrets', () => {
    const step = { kind: 'tap' as const, label: 'Login' };
    const result = interpolateStep(step, emptyBindings());
    expect(result).toBe(step); // same reference
  });

  test('leaves non-placeholder fields untouched', () => {
    const step = {
      kind: 'tap' as const,
      label: 'Login button',
      verbatim: 'tap Login button',
    };
    const result = interpolateStep(step, bindings);
    expect(result.label).toBe('Login button');
    expect(result.verbatim).toBe('tap Login button');
  });
});

// ── emptyBindings ───────────────────────────────────────────────────

describe('emptyBindings', () => {
  test('returns empty variables', () => {
    const b = emptyBindings();
    expect(b.variables).toEqual({});
  });
});

// ── mergeBindings ───────────────────────────────────────────────────

describe('mergeBindings', () => {
  test('override takes precedence', () => {
    const base: VariableBindings = {
      variables: { x: 1 },
    };
    const override: VariableBindings = {
      variables: { x: 2, y: 'hello' },
    };
    const merged = mergeBindings(base, override);
    expect(merged.variables.x).toBe(2);
    expect(merged.variables.y).toBe('hello');
  });

  test('preserves base keys not in override', () => {
    const base: VariableBindings = {
      variables: { only_base: 'val' },
    };
    const override: VariableBindings = {
      variables: { only_override: 'val2' },
    };
    const merged = mergeBindings(base, override);
    expect(merged.variables.only_base).toBe('val');
    expect(merged.variables.only_override).toBe('val2');
  });
});

// ── loadEnvironmentFile ─────────────────────────────────────────────

describe('loadEnvironmentFile', () => {
  const tmpDir = join(__dirname, '.tmp-env-test');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loads variables from YAML', () => {
    const envFile = join(tmpDir, 'test.yaml');
    writeFileSync(envFile, `variables:\n  locale: en-US\n  timeout: 30\n  debug: true\n`);
    const result = loadEnvironmentFile(envFile);
    expect(result.variables.locale).toBe('en-US');
    expect(result.variables.timeout).toBe(30);
    expect(result.variables.debug).toBe(true);
  });

  test('ignores secrets section in env file (secrets come from process.env)', () => {
    const envFile = join(tmpDir, 'test.yaml');
    writeFileSync(envFile, `secrets:\n  api_key: my-literal-key\nvariables:\n  x: 1\n`);
    const result = loadEnvironmentFile(envFile);
    // secrets section is ignored — no secrets property on bindings
    expect(result.variables.x).toBe(1);
  });

  test('throws on missing file', () => {
    expect(() => loadEnvironmentFile(join(tmpDir, 'nope.yaml'))).toThrow('not found');
  });

  test('throws on non-object YAML', () => {
    const envFile = join(tmpDir, 'bad.yaml');
    writeFileSync(envFile, 'just a string');
    expect(() => loadEnvironmentFile(envFile)).toThrow('must be a YAML object');
  });
});

// ── loadInlineBindings ──────────────────────────────────────────────

describe('loadInlineBindings', () => {
  test('loads variables from inline object', () => {
    const result = loadInlineBindings({
      variables: { locale: 'fr-FR' },
    });
    expect(result.variables.locale).toBe('fr-FR');
  });

  test('handles missing sections gracefully', () => {
    const result = loadInlineBindings({});
    expect(result.variables).toEqual({});
  });
});
