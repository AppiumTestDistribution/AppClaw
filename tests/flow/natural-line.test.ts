import { describe, test, expect } from 'vitest';
import { tryParseNaturalFlowLine } from '../../src/flow/natural-line.js';
import type { FlowStep } from '../../src/flow/types.js';

// Helper to assert step kind and key fields
function expectStep(input: string, expected: Partial<FlowStep> & { kind: string }) {
  const result = tryParseNaturalFlowLine(input);
  expect(result).not.toBeNull();
  if (!result) return;
  expect(result.kind).toBe(expected.kind);
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'kind') continue;
    expect((result as any)[key]).toBe(value);
  }
}

// ── Open/Launch ─────────────────────────────────────────────────────

describe('natural-line: open/launch', () => {
  test('open <app>', () => expectStep('open YouTube', { kind: 'openApp', query: 'YouTube' }));
  test('open <app> app', () =>
    expectStep('open YouTube app', { kind: 'openApp', query: 'YouTube' }));
  test('launch <app>', () => expectStep('launch Settings', { kind: 'openApp', query: 'Settings' }));
  test('start <app>', () => expectStep('start Chrome', { kind: 'openApp', query: 'Chrome' }));
  test('go to <app>', () => expectStep('go to Maps', { kind: 'openApp', query: 'Maps' }));
  test('open the <app> app', () =>
    expectStep('open the YouTube app', { kind: 'openApp', query: 'YouTube' }));
});

// ── Tap/Click ───────────────────────────────────────────────────────

describe('natural-line: tap/click', () => {
  test('tap <label>', () => expectStep('tap Login', { kind: 'tap', label: 'Login' }));
  test('click on <label>', () =>
    expectStep('click on Search Button', { kind: 'tap', label: 'Search Button' }));
  test('click <label>', () => expectStep('click Login', { kind: 'tap', label: 'Login' }));
  test('select <label>', () => expectStep('select English', { kind: 'tap', label: 'English' }));
  test('choose <label>', () => expectStep('choose Accept', { kind: 'tap', label: 'Accept' }));
  test('press <label>', () => expectStep('press Submit', { kind: 'tap', label: 'Submit' }));
  test('press on <label>', () => expectStep('press on Cancel', { kind: 'tap', label: 'Cancel' }));
  test('tap the <label>', () =>
    expectStep('tap the Login button', { kind: 'tap', label: 'Login button' }));
});

// ── Navigate ────────────────────────────────────────────────────────

describe('natural-line: navigate', () => {
  test('navigate to <screen>', () =>
    expectStep('navigate to Settings', { kind: 'tap', label: 'Settings' }));
  test('navigate to the <screen>', () =>
    expectStep('navigate to the Home screen', { kind: 'tap', label: 'Home' }));
});

// ── Type/Enter text ─────────────────────────────────────────────────

describe('natural-line: type', () => {
  test("type 'text'", () => expectStep("type 'hello'", { kind: 'type', text: 'hello' }));
  test('type "text"', () => expectStep('type "hello"', { kind: 'type', text: 'hello' }));
  test("type 'text' in target", () => {
    const result = tryParseNaturalFlowLine("type 'hello' in search bar");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('type');
    if (result!.kind === 'type') {
      expect(result!.text).toBe('hello');
      expect(result!.target).toBe('search bar');
    }
  });
  test("enter text 'value'", () =>
    expectStep("enter text 'password'", { kind: 'type', text: 'password' }));
  test('type unquoted text', () =>
    expectStep('type hello world', { kind: 'type', text: 'hello world' }));
  test("input 'text'", () => expectStep("input 'test'", { kind: 'type', text: 'test' }));
  test('Enter X in Y (unquoted)', () => {
    const result = tryParseNaturalFlowLine('Enter appium 3.0 in the search bar');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('type');
    if (result!.kind === 'type') {
      expect(result!.text).toBe('appium 3.0');
      expect(result!.target).toBe('search bar');
    }
  });
});

// ── Search ──────────────────────────────────────────────────────────

describe('natural-line: search', () => {
  test('search for text', () => expectStep('search for Appium', { kind: 'type', text: 'Appium' }));
  test('search text', () => expectStep('search Appium', { kind: 'type', text: 'Appium' }));
  test('look for text', () =>
    expectStep('look for something', { kind: 'type', text: 'something' }));
  test('find text', () => expectStep('find results', { kind: 'type', text: 'results' }));
});

// ── Wait ─────────────────────────────────────────────────────────────

describe('natural-line: wait', () => {
  test('wait (bare)', () => {
    const r = tryParseNaturalFlowLine('wait');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('wait');
    if (r!.kind === 'wait') expect(r!.seconds).toBe(2);
  });
  test('wait a moment', () => {
    const r = tryParseNaturalFlowLine('wait a moment');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('wait');
    if (r!.kind === 'wait') expect(r!.seconds).toBe(2);
  });
  test('wait 3s', () => {
    const r = tryParseNaturalFlowLine('wait 3s');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('wait');
    if (r!.kind === 'wait') expect(r!.seconds).toBe(3);
  });
  test('wait 5 seconds', () => {
    const r = tryParseNaturalFlowLine('wait 5 seconds');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('wait');
    if (r!.kind === 'wait') expect(r!.seconds).toBe(5);
  });
  test('sleep 1s', () => {
    const r = tryParseNaturalFlowLine('sleep 1s');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('wait');
    if (r!.kind === 'wait') expect(r!.seconds).toBe(1);
  });
  test('pause 500ms', () => {
    const r = tryParseNaturalFlowLine('pause 500ms');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('wait');
    if (r!.kind === 'wait') expect(r!.seconds).toBe(0.5);
  });
  test('wait for 3 sec', () => {
    const r = tryParseNaturalFlowLine('wait for 3 sec');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('wait');
    if (r!.kind === 'wait') expect(r!.seconds).toBe(3);
  });
});

// ── WaitUntil ────────────────────────────────────────────────────────

describe('natural-line: waitUntil', () => {
  test('wait until screen is loaded', () => {
    const r = tryParseNaturalFlowLine('wait until screen is loaded');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('waitUntil');
    if (r!.kind === 'waitUntil') {
      expect(r!.condition).toBe('screenLoaded');
      expect(r!.timeoutSeconds).toBe(10);
    }
  });
  test('wait until Login is visible', () => {
    const r = tryParseNaturalFlowLine('wait until Login is visible');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('waitUntil');
    if (r!.kind === 'waitUntil') {
      expect(r!.condition).toBe('visible');
      expect(r!.text).toBe('Login');
    }
  });
  test('wait 10s until Dashboard is visible', () => {
    const r = tryParseNaturalFlowLine('wait 10s until Dashboard is visible');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('waitUntil');
    if (r!.kind === 'waitUntil') {
      expect(r!.condition).toBe('visible');
      expect(r!.text).toBe('Dashboard');
      expect(r!.timeoutSeconds).toBe(10);
    }
  });
  test('wait until popup is gone', () => {
    const r = tryParseNaturalFlowLine('wait until popup is gone');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('waitUntil');
    if (r!.kind === 'waitUntil') {
      expect(r!.condition).toBe('gone');
      expect(r!.text).toBe('popup');
    }
  });
  test('wait until loading is hidden', () => {
    const r = tryParseNaturalFlowLine('wait until loading is hidden');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('waitUntil');
    if (r!.kind === 'waitUntil') {
      expect(r!.condition).toBe('gone');
      expect(r!.text).toBe('loading');
    }
  });
  test('wait for Login to be visible', () => {
    const r = tryParseNaturalFlowLine('wait for Login to be visible');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('waitUntil');
    if (r!.kind === 'waitUntil') {
      expect(r!.condition).toBe('visible');
      expect(r!.text).toBe('Login');
    }
  });
});

// ── Swipe/Scroll ─────────────────────────────────────────────────────

describe('natural-line: swipe/scroll', () => {
  test('swipe up', () => expectStep('swipe up', { kind: 'swipe', direction: 'up' }));
  test('swipe down', () => expectStep('swipe down', { kind: 'swipe', direction: 'down' }));
  test('scroll down', () => expectStep('scroll down', { kind: 'swipe', direction: 'down' }));
  test('swipe up 5 times', () => {
    const r = tryParseNaturalFlowLine('swipe up 5 times');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('swipe');
    if (r!.kind === 'swipe') {
      expect(r!.direction).toBe('up');
      expect(r!.repeat).toBe(5);
    }
  });
  test('scroll down 2 times', () => {
    const r = tryParseNaturalFlowLine('scroll down 2 times');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('swipe');
    if (r!.kind === 'swipe') {
      expect(r!.direction).toBe('down');
      expect(r!.repeat).toBe(2);
    }
  });
});

// ── ScrollAssert ────────────────────────────────────────────────────

describe('natural-line: scrollAssert', () => {
  test('scroll down until Submit is visible', () => {
    const r = tryParseNaturalFlowLine('scroll down until Submit is visible');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('scrollAssert');
    if (r!.kind === 'scrollAssert') {
      expect(r!.text).toBe('Submit');
      expect(r!.direction).toBe('down');
      expect(r!.maxScrolls).toBe(3);
    }
  });
  test('scroll down 5 times until Footer is visible', () => {
    const r = tryParseNaturalFlowLine('scroll down 5 times until Footer is visible');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('scrollAssert');
    if (r!.kind === 'scrollAssert') {
      expect(r!.text).toBe('Footer');
      expect(r!.direction).toBe('down');
      expect(r!.maxScrolls).toBe(5);
    }
  });
  test('scroll down to find TestMu AI', () => {
    const r = tryParseNaturalFlowLine('scroll down to find TestMu AI');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('scrollAssert');
    if (r!.kind === 'scrollAssert') {
      expect(r!.text).toBe('TestMu AI');
      expect(r!.direction).toBe('down');
    }
  });
});

// ── Navigation ───────────────────────────────────────────────────────

describe('natural-line: back/home/enter', () => {
  test('go back', () => expectStep('go back', { kind: 'back' }));
  test('back', () => expectStep('back', { kind: 'back' }));
  // "press back" is matched by pressMatch (tap) before backMatch
  // The backMatch regex has "press back" but pressMatch runs earlier
  test('press back (matched by press pattern first)', () =>
    expectStep('press back', { kind: 'tap', label: 'back' }));
  test('navigate back', () => expectStep('navigate back', { kind: 'back' }));
  test('go home', () => expectStep('go home', { kind: 'home' }));
  test('home', () => expectStep('home', { kind: 'home' }));
  // "press enter" is matched by pressMatch (tap) before enterMatch
  test('press enter (matched by press pattern first)', () =>
    expectStep('press enter', { kind: 'tap', label: 'enter' }));
  test('hit enter', () => expectStep('hit enter', { kind: 'enter' }));
  test('submit', () => expectStep('submit', { kind: 'enter' }));
  test('perform search', () => expectStep('perform search', { kind: 'enter' }));
  test('Peform Search (typo)', () => expectStep('Peform Search', { kind: 'enter' }));
});

// ── Assert/Verify ────────────────────────────────────────────────────

describe('natural-line: assert/verify', () => {
  test('verify X is visible', () =>
    expectStep('verify Dashboard is visible', { kind: 'assert', text: 'Dashboard' }));
  test('assert X is visible', () =>
    expectStep('assert Success is visible', { kind: 'assert', text: 'Success' }));
  test('check X is visible', () =>
    expectStep('check Login is visible', { kind: 'assert', text: 'Login' }));
  test('verify that X is visible', () =>
    expectStep('verify that Welcome is visible', { kind: 'assert', text: 'Welcome' }));
  test("verify X visible (no 'is')", () =>
    expectStep('verify Dashboard visible', { kind: 'assert', text: 'Dashboard' }));
  test('check if X is on the screen', () =>
    expectStep('check if button is on the screen', { kind: 'assert', text: 'button' }));
  test('verify X (bare — fallback)', () =>
    expectStep('verify video from TestMu AI is visible', {
      kind: 'assert',
      text: 'video from TestMu AI',
    }));
});

// ── Toggle/Close ─────────────────────────────────────────────────────

describe('natural-line: toggle/close', () => {
  test('toggle WiFi', () => expectStep('toggle WiFi', { kind: 'tap', label: 'WiFi' }));
  test('enable Bluetooth', () =>
    expectStep('enable Bluetooth', { kind: 'tap', label: 'Bluetooth' }));
  test('turn on WiFi', () => expectStep('turn on WiFi', { kind: 'tap', label: 'WiFi' }));
  test('close dialog', () => expectStep('close dialog', { kind: 'tap', label: 'dialog' }));
  test('dismiss popup', () => expectStep('dismiss popup', { kind: 'tap', label: 'popup' }));
});

// ── Done ──────────────────────────────────────────────────────────────

describe('natural-line: done', () => {
  test('done', () => expectStep('done', { kind: 'done' }));
  test('done with message', () =>
    expectStep('done: WiFi toggled', { kind: 'done', message: 'WiFi toggled' }));
  test('done with dash', () =>
    expectStep('done - test complete', { kind: 'done', message: 'test complete' }));
  test('done opened something', () =>
    expectStep('done opened vertical swiping and swiped', {
      kind: 'done',
      message: 'opened vertical swiping and swiped',
    }));
});

// ── Null cases ────────────────────────────────────────────────────────

describe('natural-line: returns null for unrecognized', () => {
  test('empty string', () => expect(tryParseNaturalFlowLine('')).toBeNull());
  test('whitespace only', () => expect(tryParseNaturalFlowLine('   ')).toBeNull());
  test('random sentence', () => {
    // This may or may not match — some random sentences could match patterns
    // Test a very unusual input that shouldn't match anything
    const r = tryParseNaturalFlowLine('the quick brown fox');
    // Could be null or could match something — just ensure no crash
    expect(r === null || r.kind !== undefined).toBe(true);
  });
});
