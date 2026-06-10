import { describe, expect, test } from 'vitest';
import { snapshotWithRefs } from '../src/snapshot.js';

describe('snapshot reference output', () => {
  test('emits compact references with durable selectors when available', () => {
    const result = snapshotWithRefs({
      platform: 'android',
      elements: [
        {
          type: 'Button',
          text: 'Sign in',
          id: 'login',
          accessibilityId: '',
          center: [10, 20],
          bounds: '[0,0][20,40]',
          action: 'tap',
          enabled: true,
          checked: false,
          focused: false,
          selector: { kind: 'id', value: 'login' },
        },
      ],
    });

    expect(result.output).toContain('@e1 [Button] "Sign in" id="login"');
    expect(result.refs.get('@e1')).toEqual({ selector: { kind: 'id', value: 'login' } });
  });
});
