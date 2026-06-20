/**
 * Verifies DOM-mode tap element ranking — specifically the VodQA regression
 * where "click on login button" tapped the header title "Login" instead of the
 * "LOG IN" button. Run: npx tsx tests/verify-tap-scoring.ts
 */
import { scoreTapMatch, trailingRoleWord } from '../src/flow/run-yaml-flow.js';
import type { UIElement } from '../src/perception/types.js';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failures++;
}

function el(partial: Partial<UIElement>): UIElement {
  return {
    id: '',
    accessibilityId: '',
    text: '',
    type: '',
    bounds: '',
    center: [0, 0],
    size: [0, 0],
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
    ...partial,
  };
}

/** Reproduce tryTapByLabelOnDom's ranking (score + clickable nudge + tiebreak). */
function pick(elements: UIElement[], label: string): UIElement | undefined {
  const wantsClickable = trailingRoleWord(label) != null;
  return elements
    .map((e) => ({ e, s: scoreTapMatch(e, label) }))
    .filter((x) => x.s >= 0)
    .map((x) => ({ ...x, eff: x.s + (wantsClickable && !x.e.clickable ? 0.5 : 0) }))
    .sort((a, b) => {
      if (a.eff !== b.eff) return a.eff - b.eff;
      if (a.e.clickable !== b.e.clickable) return a.e.clickable ? -1 : 1;
      return 0;
    })[0]?.e;
}

// ── The reported VodQA case ──────────────────────────────────────────
const header = el({ text: 'Login', clickable: false });
const button = el({ text: 'LOG IN', clickable: true });
check(
  '"login button" picks the clickable LOG IN button, not the header',
  pick([header, button], 'login button') === button
);
check(
  '"log in" (no role word) still prefers the clickable button on a tie',
  pick([header, button], 'log in') === button
);

// ── scoreTapMatch normalization ──────────────────────────────────────
check(
  '"LOG IN" matches needle "login" (separator-insensitive)',
  scoreTapMatch(button, 'login') === 0
);
check(
  'role word stripped: "login button" exact-matches "Login"',
  scoreTapMatch(header, 'login button') === 0
);
check('non-match returns -1', scoreTapMatch(el({ text: 'Settings' }), 'login button') === -1);
check(
  'disabled element never matches',
  scoreTapMatch(el({ text: 'Login', enabled: false }), 'login') === -1
);

// ── trailingRoleWord ─────────────────────────────────────────────────
check(
  'trailingRoleWord("login button") === "button"',
  trailingRoleWord('login button') === 'button'
);
check('trailingRoleWord("login") === null', trailingRoleWord('login') === null);
check('trailingRoleWord("button") === null (single word)', trailingRoleWord('button') === null);

// ── A literal label ending in a role word still matches exactly ──────
const radio = el({ text: 'Radio button', clickable: true });
check(
  'literal "Radio button" label exact-matches "radio button"',
  scoreTapMatch(radio, 'radio button') === 0
);

console.log(failures === 0 ? '\nAll passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
