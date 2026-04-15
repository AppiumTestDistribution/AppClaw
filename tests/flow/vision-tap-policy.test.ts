import { describe, expect, it } from 'vitest';
import { shouldPreferVisionLocateTap } from '../../src/agent/vision-tap-policy.js';

describe('shouldPreferVisionLocateTap', () => {
  it('matches digit and backspace selectors from the agent', () => {
    expect(shouldPreferVisionLocateTap('digit 1 key')).toBe(true);
    expect(shouldPreferVisionLocateTap('digit 6 key')).toBe(true);
    expect(shouldPreferVisionLocateTap('digit 3 key')).toBe(true);
    expect(shouldPreferVisionLocateTap('digit 5 key')).toBe(true);
    expect(shouldPreferVisionLocateTap('backspace key')).toBe(true);
    expect(shouldPreferVisionLocateTap('backspace key (x icon in bottom right of keypad)')).toBe(
      true
    );
  });

  it('does not match generic UI chrome', () => {
    expect(shouldPreferVisionLocateTap('Timer tab at bottom')).toBe(false);
    expect(shouldPreferVisionLocateTap('round play button')).toBe(false);
    expect(shouldPreferVisionLocateTap('search icon top right')).toBe(false);
  });
});
