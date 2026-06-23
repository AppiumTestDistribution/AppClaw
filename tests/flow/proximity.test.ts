import { describe, test, expect } from 'vitest';
import {
  rankBySpatial,
  resolveEditableForTarget,
  resolveTapTarget,
} from '../../src/flow/run-yaml-flow.js';
import type { UIElement } from '../../src/perception/types.js';

function el(
  text: string,
  center: [number, number],
  size: [number, number],
  over: Partial<UIElement> = {}
): UIElement {
  return {
    id: '',
    accessibilityId: '',
    text,
    type: '',
    bounds: '',
    center,
    size,
    clickable: false,
    editable: false,
    enabled: true,
    checked: false,
    focused: false,
    selected: false,
    scrollable: false,
    longClickable: false,
    hint: '',
    action: 'tap',
    parent: '',
    depth: 0,
    platform: 'android',
    ...over,
  };
}

// ── Login-screen layout (device-pixel coords, top-down) ──────────────
const headerLogin = el('Login', [322, 470], [180, 80], { clickable: true });
const usernameField = el('username', [430, 700], [760, 120], { editable: true });
const passwordField = el('Password', [430, 880], [760, 120], { editable: true });
const orangeLoginBtn = el('LOGIN', [430, 1200], [600, 130], { clickable: true });
const navLogin = el('Login', [310, 2300], [120, 140], { clickable: true });
const formCard = el('', [430, 900], [800, 1000]);
const loginCandidates = [headerLogin, orangeLoginBtn, navLogin];

describe('rankBySpatial: relations', () => {
  test('below → nearest below first (orange button, not nav)', () => {
    expect(rankBySpatial(loginCandidates, passwordField, 'below')).toEqual([
      orangeLoginBtn,
      navLogin,
    ]);
  });
  test('above → header tab', () => {
    expect(rankBySpatial(loginCandidates, passwordField, 'above')[0]).toBe(headerLogin);
  });
  test('near → closest by bbox distance, far excluded', () => {
    const r = rankBySpatial([usernameField, orangeLoginBtn, navLogin], passwordField, 'near');
    expect(r[0]).toBe(usernameField);
    expect(r).not.toContain(navLogin);
  });
  test('within → contained element only', () => {
    const r = rankBySpatial([orangeLoginBtn, navLogin], formCard, 'within');
    expect(r).toContain(orangeLoginBtn);
    expect(r).not.toContain(navLogin);
  });
  test('toLeftOf / toRightOf', () => {
    const a = el('A', [200, 500], [100, 60]);
    const b = el('B', [600, 500], [100, 60]);
    expect(rankBySpatial([b], a, 'toRightOf')[0]).toBe(b);
    expect(rankBySpatial([a], b, 'toLeftOf')[0]).toBe(a);
    expect(rankBySpatial([b], a, 'toLeftOf')).toHaveLength(0); // wrong side
  });
});

describe('rankBySpatial: invariants', () => {
  test('anchor itself never returned', () => {
    expect(rankBySpatial([passwordField, orangeLoginBtn], passwordField, 'below')).not.toContain(
      passwordField
    );
  });
  test('no qualifying candidate → empty', () => {
    expect(rankBySpatial([orangeLoginBtn, navLogin], headerLogin, 'above')).toHaveLength(0);
  });
  test('disabled candidates dropped', () => {
    const disabled = el('LOGIN', [430, 1200], [600, 130], { enabled: false });
    expect(rankBySpatial([disabled], passwordField, 'below')).toHaveLength(0);
  });
  test('near expands to reach a moderately distant candidate', () => {
    const anchor = el('a', [100, 100], [20, 20]);
    const reachable = el('b', [100, 250], [20, 20]); // found only after a few expansions
    expect(rankBySpatial([reachable], anchor, 'near')[0]).toBe(reachable);
  });
  test('near is bounded — does not match across the whole screen', () => {
    const anchor = el('a', [100, 100], [20, 20]);
    const tooFar = el('b', [100, 5000], [20, 20]);
    expect(rankBySpatial([tooFar], anchor, 'near')).toHaveLength(0);
  });
});

describe('resolveEditableForTarget', () => {
  const emailInput = el('', [430, 700], [760, 120], { hint: 'Email', editable: true });
  const pwdInput = el('', [430, 880], [760, 120], { hint: 'Password', editable: true });
  const userLabel = el('Username', [120, 600], [200, 40]);
  const elements = [userLabel, emailInput, pwdInput];

  test('target picks THAT field, not the first editable (latent bug)', () => {
    expect(resolveEditableForTarget(elements, 'password').el).toBe(pwdInput);
    expect(resolveEditableForTarget(elements, 'email').el).toBe(emailInput);
  });
  test('label-only target → nearest editable', () => {
    expect(resolveEditableForTarget(elements, 'username').el).toBe(emailInput);
  });
  test('no target → first editable', () => {
    expect(resolveEditableForTarget(elements).el).toBe(emailInput);
  });
  test('explicit proximity narrows by anchor', () => {
    expect(
      resolveEditableForTarget(elements, undefined, { relation: 'below', anchor: 'username' }).el
    ).toBe(emailInput);
  });
  test('unmatched target → null + reason', () => {
    const r = resolveEditableForTarget(elements, 'zzz');
    expect(r.el).toBeNull();
    expect(r.reason).toBeTruthy();
  });
  test('no editable fields → null + reason', () => {
    const r = resolveEditableForTarget([userLabel], 'username');
    expect(r.el).toBeNull();
    expect(r.reason).toMatch(/no editable/i);
  });
  test('proximity anchor missing → null + reason', () => {
    const r = resolveEditableForTarget(elements, undefined, { relation: 'below', anchor: 'nope' });
    expect(r.el).toBeNull();
    expect(r.reason).toMatch(/not found/i);
  });
});

// Faithful to the WDIO login screen page source (center/size in device px).
// The help paragraph mentions "login button" and sits CLOSER to the password
// field than the real submit button — the exact trap that mis-fired before.
describe('resolveTapTarget: WDIO login screen', () => {
  const headerToggle = el('button-login-container', [529, 739], [311, 140], {
    accessibilityId: 'button-login-container',
    clickable: true,
  });
  const passwordInput = el('Password', [789, 1412], [1093, 158], {
    accessibilityId: 'input-password',
    hint: 'Password',
    editable: true,
    clickable: true,
  });
  const biometricsHelp = el(
    'When the device has Touch/FaceID enabled a biometrics button will be shown to test the login.',
    [720, 1681],
    [1300, 180]
  ); // clickable: false — pure text
  const orangeLogin = el('button-LOGIN', [721, 1971], [990, 150], {
    accessibilityId: 'button-LOGIN',
    clickable: true,
  });
  const navLogin = el('Login', [514, 2931], [160, 170], {
    accessibilityId: 'Login',
    clickable: true,
  });
  const screen = [headerToggle, passwordInput, biometricsHelp, orangeLogin, navLogin];

  test('"login button near password field" → orange submit, not the help paragraph', () => {
    const r = resolveTapTarget(screen, 'login button', {
      relation: 'near',
      anchor: 'password field',
    });
    expect(r.el).toBe(orangeLogin);
  });
  test('"login button below password field" → orange submit, not nav', () => {
    const r = resolveTapTarget(screen, 'login button', {
      relation: 'below',
      anchor: 'password field',
    });
    expect(r.el).toBe(orangeLogin);
  });
  test('non-clickable help paragraph is never the spatial pick', () => {
    const r = resolveTapTarget(screen, 'login button', {
      relation: 'near',
      anchor: 'password field',
    });
    expect(r.el).not.toBe(biometricsHelp);
  });
  test('anchor "password field" resolves and is not returned as the pick', () => {
    const r = resolveTapTarget(screen, 'login button', {
      relation: 'near',
      anchor: 'password field',
    });
    expect(r.el).not.toBe(passwordInput);
  });
});

describe('resolveEditableForTarget: iOS elements', () => {
  // Parser fills the same fields cross-platform; resolver is platform-agnostic.
  const f1 = el('', [400, 600], [700, 110], { hint: 'Email', editable: true, platform: 'ios' });
  const f2 = el('', [400, 760], [700, 110], { hint: 'Password', editable: true, platform: 'ios' });
  test('targets the password field on iOS too', () => {
    expect(resolveEditableForTarget([f1, f2], 'password').el).toBe(f2);
  });
});
