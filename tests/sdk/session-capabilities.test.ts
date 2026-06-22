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

  test('throws when the file is platform-scoped but the requested platform has no section', () => {
    // The user explicitly split caps by platform and forgot ios — refuse rather
    // than silently running with just `common`, which masks the missing
    // ios-specific values (app path, automationName, etc.).
    expect(() =>
      normalizeCapabilitiesForPlatform(
        {
          common: { 'appium:noReset': true },
          android: { 'appium:app': '/tmp/android.apk' },
        },
        'ios',
        'caps.json'
      )
    ).toThrow(/caps\.json declares platform sections \[android\] but no "ios" section/);
  });

  test('rejects non-object platform sections', () => {
    expect(() =>
      normalizeCapabilitiesForPlatform({ android: '/tmp/app.apk' }, 'android', 'caps.json')
    ).toThrow('caps.json field "android" must be a JSON object of capabilities');
  });
});
