/**
 * VariableResolver — resolves `${variables.X}` and `${secrets.X}` placeholders
 * in flow step strings.
 *
 * - **Secrets** (`${secrets.X}`) are resolved directly from `process.env[X]`
 *   at runtime. They are never stored in YAML or env files.
 * - **Variables** (`${variables.X}`) are loaded from `.appclaw/env/<name>.yaml`
 *   files or inline `env:` blocks in the YAML header.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { parse as parseYaml } from 'yaml';

// ── Types ──────────────────────────────────────────────────────────

export interface VariableBindings {
  variables: Record<string, string | number | boolean>;
}

export interface ResolveResult {
  resolved: string;
  redacted: string;
}

// ── Loading ────────────────────────────────────────────────────────

/**
 * Load an environment YAML file and return variable bindings.
 *
 * Expected YAML shape:
 * ```yaml
 * variables:
 *   locale: en-US
 *   timeout: 30
 *   app_name: youtube
 * ```
 */
export function loadEnvironmentFile(filePath: string): VariableBindings {
  if (!existsSync(filePath)) {
    throw new Error(`Environment file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const doc = parseYaml(raw);

  if (!doc || typeof doc !== 'object') {
    throw new Error(`Environment file must be a YAML object: ${filePath}`);
  }

  const bindings: VariableBindings = { variables: {} };

  if (doc.variables && typeof doc.variables === 'object') {
    for (const [key, val] of Object.entries(doc.variables)) {
      if (val === null || val === undefined) continue;
      bindings.variables[key] = val as string | number | boolean;
    }
  }

  return bindings;
}

/**
 * Build bindings from inline `env:` block in the YAML header.
 */
export function loadInlineBindings(env: Record<string, unknown>): VariableBindings {
  const bindings: VariableBindings = { variables: {} };

  if (env.variables && typeof env.variables === 'object') {
    for (const [key, val] of Object.entries(env.variables as Record<string, unknown>)) {
      if (val === null || val === undefined) continue;
      bindings.variables[key] = val as string | number | boolean;
    }
  }

  return bindings;
}

// ── Merging ────────────────────────────────────────────────────────

/** Merge two bindings, with `override` taking precedence. */
export function mergeBindings(
  base: VariableBindings,
  override: VariableBindings
): VariableBindings {
  return {
    variables: { ...base.variables, ...override.variables },
  };
}

/** Empty bindings — no variables. */
export function emptyBindings(): VariableBindings {
  return { variables: {} };
}

// ── Interpolation ──────────────────────────────────────────────────

const PLACEHOLDER_RE = /\$\{(secrets|variables)\.([^}]+)\}/g;

/**
 * Interpolate `${secrets.X}` and `${variables.X}` placeholders in a string.
 *
 * - **secrets** are resolved directly from `process.env[X]` at runtime.
 * - **variables** are resolved from the provided bindings (env YAML files).
 *
 * Returns both the resolved string and a redacted version (secrets replaced with `***`).
 * Throws if a referenced binding is not found.
 */
export function interpolate(template: string, bindings: VariableBindings): ResolveResult {
  let resolved = template;
  let redacted = template;

  resolved = resolved.replace(PLACEHOLDER_RE, (_match, scope: string, key: string) => {
    if (scope === 'secrets') {
      const value = process.env[key];
      if (value === undefined) {
        throw new Error(
          `Undefined secret: "\${secrets.${key}}". ` +
            `Set the environment variable "${key}" in your shell or .env file.`
        );
      }
      return value;
    }
    if (!(key in bindings.variables)) {
      throw new Error(
        `Undefined variable: "\${variables.${key}}". Define it in your environment file.`
      );
    }
    return String(bindings.variables[key]);
  });

  redacted = redacted.replace(PLACEHOLDER_RE, (_match, scope: string, key: string) => {
    if (scope === 'secrets') return '***';
    if (scope === 'variables' && key in bindings.variables) {
      return String(bindings.variables[key]);
    }
    return _match;
  });

  return { resolved, redacted };
}

/**
 * Check whether a string contains any `${secrets.X}` or `${variables.X}` placeholders.
 * Uses a fresh regex to avoid lastIndex issues with the global flag.
 */
export function hasPlaceholders(text: string): boolean {
  return /\$\{(secrets|variables)\.[^}]+\}/.test(text);
}

/**
 * Interpolate all string fields of a FlowStep, returning a new step with resolved values
 * and keeping track of the redacted verbatim for display.
 */
export function interpolateStep<T extends Record<string, unknown>>(
  step: T,
  bindings: VariableBindings
): T {
  // Check if any interpolation is needed (variables in bindings or secrets in step strings)
  const hasVars = Object.keys(bindings.variables).length > 0;
  const hasSecretPlaceholders = Object.values(step).some(
    (v) => typeof v === 'string' && /\$\{secrets\.[^}]+\}/.test(v)
  );
  if (!hasVars && !hasSecretPlaceholders) {
    return step;
  }

  const result = { ...step };

  // First pass: resolve all string fields (except verbatim)
  for (const [key, val] of Object.entries(result)) {
    if (key === 'verbatim') continue;
    if (typeof val === 'string' && hasPlaceholders(val)) {
      const { resolved } = interpolate(val, bindings);
      (result as Record<string, unknown>)[key] = resolved;
    }
  }

  // Second pass: set verbatim to redacted form (secrets hidden, variables shown)
  if (typeof result.verbatim === 'string' && hasPlaceholders(result.verbatim)) {
    (result as Record<string, unknown>).verbatim = interpolate(
      result.verbatim as string,
      bindings
    ).redacted;
  }

  return result;
}
