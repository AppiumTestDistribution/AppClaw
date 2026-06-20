/**
 * Verifies element-anchored swipe parsing — "swipe the slider to the right"
 * must keep the target (so DOM mode can anchor the gesture) while plain
 * directional swipes stay target-less. Run: npx tsx tests/verify-swipe-parsing.ts
 */
import { tryParseNaturalFlowLine } from '../src/flow/natural-line.js';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failures++;
}

type SwipeStep = { kind: string; direction?: string; target?: string; repeat?: number };
const parse = (s: string) => tryParseNaturalFlowLine(s) as SwipeStep | null;

// ── Anchored swipes keep their target ────────────────────────────────
const anchored = parse('swipe the first slider dot to the right');
check(
  'reported case parses as anchored swipe',
  anchored?.kind === 'swipe' && anchored.direction === 'right'
);
check('reported case keeps target "first slider dot"', anchored?.target === 'first slider dot');

const left = parse('swipe the slider to the left');
check(
  '"swipe the slider to the left" → target "slider", dir left',
  left?.target === 'slider' && left.direction === 'left'
);

const bare = parse('swipe slider right');
check(
  '"swipe slider right" → target "slider", dir right',
  bare?.target === 'slider' && bare.direction === 'right'
);

const up = parse('swipe the volume control up');
check(
  '"swipe the volume control up" → target "volume control", dir up',
  up?.target === 'volume control' && up.direction === 'up'
);

// ── Plain directional swipes have NO target ──────────────────────────
for (const [input, dir] of [
  ['swipe right', 'right'],
  ['swipe up', 'up'],
  ['swipe to the right', 'right'],
  ['swipe to the left', 'left'],
] as const) {
  const got = parse(input);
  check(
    `"${input}" → plain swipe ${dir}, no target`,
    got?.kind === 'swipe' && got.direction === dir && got.target === undefined
  );
}

const repeated = parse('swipe up 3 times');
check(
  '"swipe up 3 times" → repeat 3, no target',
  repeated?.repeat === 3 && repeated.target === undefined
);

// ── "drag/slide/move X to Y" stays a drag (vision element-to-element) ─
check(
  '"drag the box to the trash" stays kind:drag',
  parse('drag the box to the trash')?.kind === 'drag'
);

console.log(failures === 0 ? '\nAll passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
