import { describe, expect, test } from 'vitest';
import { normalizeCapabilitiesForPlatform } from '../../src/device/session.js';

describe('normalizeCapabilitiesForPlatform', () => {
  test('keeps flat capability files unchanged', () => {
    expect(
      normalizeCapabilitiesForPlatform(
        {
          'appium:app': '/tmp/app.apk',
          'appium:autoGrantPermissions': true,
        },
        'android'
      )
    ).toEqual({
      'appium:app': '/tmp/app.apk',
      'appium:autoGrantPermissions': true,
    });
  });

  test('unwraps the selected platform section', () => {
    expect(
      normalizeCapabilitiesForPlatform(
        {
          android: {
            'appium:app': '/tmp/android.apk',
            'appium:automationName': 'UiAutomator2',
          },
          ios: {
            'appium:app': '/tmp/ios.ipa',
            'appium:automationName': 'XCUITest',
          },
        },
        'android'
      )
    ).toEqual({
      'appium:app': '/tmp/android.apk',
      'appium:automationName': 'UiAutomator2',
    });
  });

  test('merges top-level and shared caps before platform-specific caps', () => {
    expect(
      normalizeCapabilitiesForPlatform(
        {
          'appium:noReset': true,
          common: { 'appium:autoGrantPermissions': true, 'appium:app': '/tmp/common.apk' },
          android: { 'appium:app': '/tmp/android.apk' },
        },
        'android'
      )
    ).toEqual({
      'appium:noReset': true,
      'appium:autoGrantPermissions': true,
      'appium:app': '/tmp/android.apk',
    });
  });

  test('does not leak platform wrapper keys when selected platform has no section', () => {
    expect(
      normalizeCapabilitiesForPlatform(
        {
          common: { 'appium:noReset': true },
          android: { 'appium:app': '/tmp/android.apk' },
        },
        'ios'
      )
    ).toEqual({
      'appium:noReset': true,
    });
  });

  test('rejects non-object platform sections', () => {
    expect(() =>
      normalizeCapabilitiesForPlatform({ android: '/tmp/app.apk' }, 'android', 'caps.json')
    ).toThrow('caps.json field "android" must be a JSON object of capabilities');
  });
});
