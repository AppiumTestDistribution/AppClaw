import { describe, expect, it } from 'vitest';
import { computePerceptionHash, computeScreenHash } from '../../src/perception/screen-diff.js';
import { createStuckDetector, isDataEntryLikeGoal } from '../../src/agent/stuck.js';

describe('computePerceptionHash', () => {
  it('uses DOM when non-empty', () => {
    const dom = '<FrameLayout text="Hi"/>';
    expect(computePerceptionHash(dom, 'screenshotdata')).toBe(computeScreenHash(dom));
  });

  it('uses screenshot when DOM empty', () => {
    const a = computePerceptionHash('', 'base64imageA');
    const b = computePerceptionHash('', 'base64imageB');
    expect(a).not.toBe(b);
  });

  it('matches for same screenshot payload', () => {
    const img = 'x'.repeat(50000);
    expect(computePerceptionHash('', img)).toBe(computePerceptionHash('', img));
  });

  it('whitespace-only DOM falls back to screenshot', () => {
    const img = 'abc';
    expect(computePerceptionHash('   \n', img)).toBe(computePerceptionHash('', img));
  });
});

describe('isDataEntryLikeGoal', () => {
  it('matches timer typing sub-goals', () => {
    expect(isDataEntryLikeGoal("Type '001635' into the timer duration input field")).toBe(true);
  });

  it('matches generic keypad goals', () => {
    expect(isDataEntryLikeGoal('Enter PIN 1234')).toBe(true);
  });

  it('does not match unrelated goals', () => {
    expect(isDataEntryLikeGoal('Open Settings and enable WiFi')).toBe(false);
  });
});

describe('createStuckDetector', () => {
  it('does not flag ordered keypad entry as stuck when screen changes', () => {
    const detector = createStuckDetector();
    const goal = "Tap the keys '1', '6', '3', '5' on the digit pad";

    detector.recordAction('find_and_click', 'h1');
    detector.recordAction('find_and_click', 'h2');
    detector.recordAction('find_and_click', 'h3');

    expect(detector.isStuck(goal)).toBe(false);
  });

  it('still flags data entry as stuck when screen stays unchanged', () => {
    const detector = createStuckDetector();
    const goal = "Tap the keys '1', '6', '3', '5' on the digit pad";

    detector.recordAction('find_and_click', 'same');
    detector.recordAction('find_and_click', 'same');
    detector.recordAction('find_and_click', 'same');
    detector.recordAction('find_and_click', 'same');

    expect(detector.isStuck(goal)).toBe(true);
  });

  it('reports stuck signal names for debugging', () => {
    const detector = createStuckDetector();
    const goal = 'Open Settings and enable WiFi';

    detector.recordAction('find_and_click', 'same');
    detector.recordAction('find_and_click', 'same');
    detector.recordAction('find_and_click', 'same');
    detector.recordAction('find_and_click', 'same');

    expect(detector.isStuck(goal)).toBe(true);
    expect(detector.getLastSignals()).toEqual(expect.arrayContaining(['repetition', 'unchanged']));
  });
});
