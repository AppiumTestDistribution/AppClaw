import { describe, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { parseInvocation, parseTarget } from '../src/parser.js';

describe('appclaw-agent CLI parsing', () => {
  test('parses a named interactive snapshot command', () => {
    expect(parseInvocation(['--session', 'qa', 'snapshot', '-i', '--json'])).toEqual({
      session: 'qa',
      json: true,
      command: { kind: 'snapshot', interactiveOnly: true },
    });
  });

  test('parses open options without affecting the existing appclaw CLI', () => {
    const parsed = parseInvocation([
      '--session',
      'login',
      'open',
      'com.example',
      '--platform',
      'android',
      '--udid',
      'emulator-5554',
    ]);
    expect(parsed.command).toEqual({
      kind: 'open',
      options: {
        app: 'com.example',
        platform: 'android',
        udid: 'emulator-5554',
      },
    });
  });

  test('parses explicit vision commands', () => {
    expect(parseInvocation(['press', '--vision', 'cart icon']).command).toEqual({
      kind: 'press',
      target: { text: 'cart icon' },
      vision: 'cart icon',
    });
    expect(parseInvocation(['get', 'info', '--vision', 'displayed total']).command).toEqual({
      kind: 'getInfo',
      vision: 'displayed total',
    });
  });

  test('supports refs and stable selectors', () => {
    expect(parseTarget('@e2')).toEqual({ ref: '@e2' });
    expect(parseTarget('id="login"')).toEqual({ selector: { kind: 'id', value: 'login' } });
    expect(parseTarget('accessibility="Sign in"')).toEqual({
      selector: { kind: 'accessibility', value: 'Sign in' },
    });
  });

  test('resolves screenshot output in the invoking working directory', () => {
    expect(parseInvocation(['screenshot', 'evidence.png']).command).toEqual({
      kind: 'screenshot',
      path: resolve('evidence.png'),
    });
  });
});
