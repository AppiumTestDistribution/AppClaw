/**
 * CompletionProvider for AppClaw YAML flows.
 *
 * Provides autocomplete for:
 * 1. ${secrets.X} and ${variables.X} — reads from .appclaw/env/*.yaml
 * 2. Step actions — common natural-language patterns
 * 3. Top-level keys — name, platform, setup, steps, assertions, env
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface EnvBindings {
  secrets: string[];
  variables: string[];
}

/**
 * Scan .appclaw/env/ for all available environment files and collect variable keys.
 * Secrets are resolved from process.env at runtime — no autocomplete for those.
 */
function loadAvailableBindings(workspaceRoot: string): EnvBindings {
  const envDir = path.join(workspaceRoot, '.appclaw', 'env');
  const result: EnvBindings = { secrets: [], variables: [] };

  if (!fs.existsSync(envDir)) return result;

  const varSet = new Set<string>();

  try {
    const files = fs.readdirSync(envDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(envDir, file), 'utf-8');
      let inVariables = false;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'variables:' || trimmed.startsWith('variables:')) {
          inVariables = true;
          continue;
        }
        // Top-level key resets context
        if (/^\S/.test(line) && trimmed.includes(':')) {
          inVariables = false;
          continue;
        }
        const keyMatch = trimmed.match(/^(\w+)\s*:/);
        if (keyMatch && inVariables) {
          varSet.add(keyMatch[1]);
        }
      }
    }
  } catch {
    // Silently fail — no completions if env dir is unreadable
  }

  result.variables = [...varSet].sort();
  return result;
}

/** Get available environment names from .appclaw/env/ */
function getEnvNames(workspaceRoot: string): string[] {
  const envDir = path.join(workspaceRoot, '.appclaw', 'env');
  if (!fs.existsSync(envDir)) return [];
  try {
    return fs
      .readdirSync(envDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => f.replace(/\.(yaml|yml)$/, ''))
      .sort();
  } catch {
    return [];
  }
}

const STEP_SNIPPETS = [
  // Actions
  { label: 'tap', insert: 'tap ${1:element}', detail: 'Tap an element by label' },
  { label: 'click on', insert: 'click on ${1:element}', detail: 'Click on an element' },
  { label: 'type', insert: "type '${1:text}'", detail: 'Type text into focused field' },
  {
    label: 'type in',
    insert: "type '${1:text}' in ${2:field}",
    detail: 'Type text into a specific field',
  },
  {
    label: 'type secret',
    insert: "type '\\${secrets.${1:key}}' in ${2:field}",
    detail: 'Type a secret value',
  },
  {
    label: 'type variable',
    insert: "type '\\${variables.${1:key}}' in ${2:field}",
    detail: 'Type a variable value',
  },

  // Navigation
  { label: 'open app', insert: 'open ${1:AppName}', detail: 'Open/launch an app by name' },
  { label: 'go back', insert: 'go back', detail: 'Press back button' },
  { label: 'press home', insert: 'press home', detail: 'Press home button' },
  { label: 'press enter', insert: 'press enter', detail: 'Press enter/return key' },

  // Waits
  { label: 'wait', insert: 'wait ${1:2}s', detail: 'Wait for N seconds' },
  {
    label: 'wait until visible',
    insert: 'wait until ${1:element} is visible',
    detail: 'Wait for element to appear',
  },
  {
    label: 'wait until gone',
    insert: 'wait until ${1:element} is gone',
    detail: 'Wait for element to disappear',
  },
  {
    label: 'wait until screen loaded',
    insert: 'wait until screen is loaded',
    detail: 'Wait for screen to stabilize',
  },

  // Scroll
  { label: 'swipe up', insert: 'swipe up', detail: 'Swipe up once' },
  { label: 'swipe down', insert: 'swipe down', detail: 'Swipe down once' },
  { label: 'scroll down', insert: 'scroll down ${1:3} times', detail: 'Scroll down N times' },
  {
    label: 'scroll until visible',
    insert: 'scroll down until ${1:element} is visible',
    detail: 'Scroll until element found',
  },

  // Assertions
  {
    label: 'verify',
    insert: 'verify ${1:text} is visible',
    detail: 'Assert text is visible on screen',
  },
  {
    label: 'assert',
    insert: 'assert ${1:text} is visible',
    detail: 'Assert text is visible on screen',
  },
  { label: 'check', insert: 'check ${1:text} is visible', detail: 'Check element visibility' },

  // Done
  { label: 'done', insert: 'done', detail: 'End the flow (unconditional pass)' },
  {
    label: 'done with message',
    insert: 'done: ${1:expected text on screen}',
    detail: 'End flow and verify message',
  },
];

const TOP_LEVEL_KEYS = [
  { label: 'name', insert: 'name: ${1:flow_name}', detail: 'Flow name' },
  {
    label: 'description',
    insert: 'description: ${1:What this test verifies}',
    detail: 'Flow description',
  },
  { label: 'platform', insert: 'platform: ${1|android,ios|}', detail: 'Target platform' },
  { label: 'appId', insert: 'appId: ${1:com.example.app}', detail: 'App package/bundle ID' },
  { label: 'env', insert: 'env: ${1:dev}', detail: 'Environment name' },
  {
    label: 'setup',
    insert: 'setup:\n  - ${1:open MyApp}',
    detail: 'Setup phase — initialization steps',
  },
  {
    label: 'steps',
    insert: 'steps:\n  - ${1:tap Login}',
    detail: 'Test phase — main test actions',
  },
  {
    label: 'assertions',
    insert: 'assertions:\n  - ${1:verify Dashboard is visible}',
    detail: 'Assertion phase — verification checks',
  },
];

export class FlowCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): vscode.CompletionItem[] {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    const items: vscode.CompletionItem[] = [];
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // ── ${secrets.X} and ${variables.X} completion ──
    const varMatch = textBefore.match(/\$\{(secrets|variables)\.(\w*)$/);
    if (varMatch && workspaceRoot) {
      const scope = varMatch[1];
      const partial = varMatch[2];
      const bindings = loadAvailableBindings(workspaceRoot);
      const keys = scope === 'secrets' ? bindings.secrets : bindings.variables;

      for (const key of keys) {
        if (partial && !key.startsWith(partial)) continue;
        const item = new vscode.CompletionItem(
          key,
          scope === 'secrets' ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Variable
        );
        item.detail = `\${${scope}.${key}}`;
        item.documentation =
          scope === 'secrets'
            ? 'Secret — resolved from environment variable at runtime (redacted in output)'
            : 'Variable value';
        // Replace from the partial start
        const startChar = position.character - partial.length;
        item.range = new vscode.Range(position.line, startChar, position.line, position.character);
        item.insertText = key;
        items.push(item);
      }
      return items;
    }

    // ── env: value completion ──
    const envMatch = textBefore.match(/^env:\s*(\w*)$/);
    if (envMatch && workspaceRoot) {
      const partial = envMatch[1];
      const envNames = getEnvNames(workspaceRoot);
      for (const name of envNames) {
        if (partial && !name.startsWith(partial)) continue;
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
        item.detail = `.appclaw/env/${name}.yaml`;
        items.push(item);
      }
      return items;
    }

    // ── Step completions (inside setup:/steps:/assertions: arrays) ──
    const isStepLine = /^\s+-\s*/.test(textBefore);
    if (isStepLine) {
      const afterDash = textBefore.replace(/^\s+-\s*/, '');
      for (const snippet of STEP_SNIPPETS) {
        if (afterDash && !snippet.label.startsWith(afterDash.toLowerCase())) continue;
        const item = new vscode.CompletionItem(snippet.label, vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(snippet.insert);
        item.detail = snippet.detail;
        item.sortText = `0_${snippet.label}`; // Sort before other completions
        items.push(item);
      }
      return items;
    }

    // ── Top-level key completions ──
    const isTopLevel = /^(\w*)$/.test(textBefore.trim()) && position.character <= textBefore.length;
    if (isTopLevel || textBefore.trim() === '') {
      for (const key of TOP_LEVEL_KEYS) {
        const item = new vscode.CompletionItem(key.label, vscode.CompletionItemKind.Property);
        item.insertText = new vscode.SnippetString(key.insert);
        item.detail = key.detail;
        items.push(item);
      }
      return items;
    }

    return items;
  }
}
