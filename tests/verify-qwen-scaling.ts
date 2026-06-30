/**
 * Scaling validation for the native Qwen vision locator.
 *
 * Part A (always runs, no server needed): proves the pure scaling math —
 *   bbox(sent-image px) → device-pixel center — lands inside the true bbox for
 *   both Android (pixels) and iOS-shaped (points) device sizes, plus the parser.
 *
 * Part B (runs only if LM Studio is reachable): sends the actual downscaled
 *   400×400 test image to STARK_VISION_BASE_URL/STARK_VISION_MODEL and asserts the
 *   computed device-pixel center lands inside each colored element's true box.
 *
 * Run: npx tsx tests/verify-qwen-scaling.ts
 */

import sharp from 'sharp';
import {
  bboxCenterToDevice,
  parseQwenBoxes,
  downscaleForVision,
} from '../src/vision/qwen-locate.js';
import {
  QwenVisionClient,
  normalizeOpenAIBaseUrl,
  pixelCenterFromCoords,
} from '../src/vision/qwen-vision-client.js';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    console.log(`  ❌ ${name} ${extra}`);
    failures++;
  }
}

/** Ground-truth element boxes in the 400×400 test image (x1,y1,x2,y2). */
const ELEMENTS = {
  red: { box: [40, 40, 160, 160] as [number, number, number, number] },
  green: { box: [240, 40, 360, 160] as [number, number, number, number] },
  blue: { box: [40, 240, 160, 360] as [number, number, number, number] },
};

function inside(p: { x: number; y: number }, box: [number, number, number, number]): boolean {
  return p.x >= box[0] && p.x <= box[2] && p.y >= box[1] && p.y <= box[3];
}

/** Build a 400×400 PNG with three solid colored squares at the known positions. */
async function makeTestImage(): Promise<string> {
  const W = 400;
  const H = 400;
  const channels = 3;
  const buf = Buffer.alloc(W * H * channels, 0); // black background
  const paint = (box: number[], r: number, g: number, b: number) => {
    for (let y = box[1]; y < box[3]; y++) {
      for (let x = box[0]; x < box[2]; x++) {
        const i = (y * W + x) * channels;
        buf[i] = r;
        buf[i + 1] = g;
        buf[i + 2] = b;
      }
    }
  };
  paint(ELEMENTS.red.box, 220, 30, 30);
  paint(ELEMENTS.green.box, 30, 200, 30);
  paint(ELEMENTS.blue.box, 30, 30, 220);
  const png = await sharp(buf, { raw: { width: W, height: H, channels } })
    .png()
    .toBuffer();
  return png.toString('base64');
}

async function partA(): Promise<void> {
  console.log('\n── Part A: pure scaling + parser (no server) ──');

  // Parser tolerance.
  check('parses bare JSON array', !!parseQwenBoxes('[{"bbox_2d":[1,2,3,4],"label":"x"}]'));
  check('parses ```json fenced output', !!parseQwenBoxes('```json\n[{"bbox_2d":[1,2,3,4]}]\n```'));
  check(
    'parses array embedded in prose',
    !!parseQwenBoxes('Here it is: [{"bbox_2d":[1,2,3,4]}] done')
  );
  check('empty array → []', (parseQwenBoxes('[]') ?? null)?.length === 0);
  check('garbage → null', parseQwenBoxes('no json here') === null);

  // Qwen returns either a 4-element box OR a 2-element point — both must yield a center.
  const c4 = pixelCenterFromCoords([10, 20, 30, 40]);
  check('4-element box → center (20,30)', !!c4 && c4.cx === 20 && c4.cy === 30, JSON.stringify(c4));
  const c2 = pixelCenterFromCoords([10, 134]);
  check(
    '2-element point → center (10,134)',
    !!c2 && c2.cx === 10 && c2.cy === 134,
    JSON.stringify(c2)
  );
  check('1-element → null', pixelCenterFromCoords([5]) === null);
  check('undefined → null', pixelCenterFromCoords(undefined) === null);
  // The [null,null] case: Qwen sometimes claims an element is visible but emits
  // null coords. The gate must treat that as not-found (no tap at NaN/0,0).
  check(
    '[null,null] → null (visible-but-no-coords guard)',
    pixelCenterFromCoords([null as any, null as any]) === null
  );
  check('[NaN] box → null', pixelCenterFromCoords([NaN, 1, 2, 3]) === null);

  // Scaling: a box found in a 200×200 sent image must map into the true box of
  // the same element scaled up to the device. We emulate Qwen by halving the
  // ground-truth boxes (since 400 → 200 downscale = scale 2.0 back up).
  const sent = { width: 200, height: 200 };
  const devices = [
    { name: 'Android 1080×2400 px', width: 1080, height: 2400 },
    { name: 'iPhone 393×852 pts', width: 393, height: 852 },
    { name: 'square 400×400', width: 400, height: 400 },
  ];
  for (const dev of devices) {
    const sx = dev.width / sent.width;
    const sy = dev.height / sent.height;
    for (const [name, el] of Object.entries(ELEMENTS)) {
      // bbox as Qwen would report it in the 200px sent image (half the 400px truth)
      const sentBox = el.box.map((v) => v / 2) as [number, number, number, number];
      const center = bboxCenterToDevice(sentBox, sx, sy);
      // True device box = ground-truth scaled to device dimensions
      const deviceTrueBox: [number, number, number, number] = [
        (el.box[0] / 400) * dev.width,
        (el.box[1] / 400) * dev.height,
        (el.box[2] / 400) * dev.width,
        (el.box[3] / 400) * dev.height,
      ];
      check(
        `${dev.name}: ${name} center inside true device box`,
        inside(center, deviceTrueBox),
        `center=(${center.x.toFixed(0)},${center.y.toFixed(0)}) box=${deviceTrueBox.map((v) => v.toFixed(0))}`
      );
    }
  }
}

async function partB(): Promise<void> {
  const baseUrl = (process.env.STARK_VISION_BASE_URL || '').trim();
  const model = (process.env.STARK_VISION_MODEL || '').trim();
  if (!baseUrl || !model) {
    console.log(
      '\n── Part B: skipped (set STARK_VISION_BASE_URL + STARK_VISION_MODEL to run live) ──'
    );
    return;
  }

  // Reachability probe against the normalized /v1 endpoint (the real code path).
  const normUrl = normalizeOpenAIBaseUrl(baseUrl);
  try {
    const ping = await fetch(`${normUrl}/models`, { method: 'GET' });
    if (!ping.ok) throw new Error(`models endpoint ${ping.status}`);
  } catch (e) {
    console.log(
      `\n── Part B: skipped (server unreachable at ${normUrl}: ${e instanceof Error ? e.message : e}) ──`
    );
    return;
  }

  console.log(`\n── Part B: live grounding via QwenVisionClient against ${model} (${normUrl}) ──`);
  const raw = await makeTestImage();
  const sent = await downscaleForVision(raw);
  // Device == the original 400×400 image (no real device): scale relative to sent.
  const scaleX = 400 / sent.width;
  const scaleY = 400 / sent.height;
  console.log(
    `  sent ${sent.width}×${sent.height} (${sent.mime}), scale ${scaleX.toFixed(3)},${scaleY.toFixed(3)}`
  );

  const client = new QwenVisionClient({ baseUrl, model });

  // B1: pure grounding (agent-loop path) — locateBoxPixels returns sent-image pixels.
  for (const [name, el] of Object.entries(ELEMENTS)) {
    const t0 = performance.now();
    const located = await client.locateBoxPixels(`the ${name} square`, sent.base64);
    const ms = Math.round(performance.now() - t0);
    if (!located) {
      check(`grounding ${name}: got a bbox (${ms}ms)`, false, 'locateBoxPixels returned null');
      continue;
    }
    const center = bboxCenterToDevice(located.bbox, scaleX, scaleY);
    check(
      `grounding ${name}: center inside true box (${ms}ms)`,
      inside(center, el.box),
      `center=(${center.x.toFixed(0)},${center.y.toFixed(0)}) true=${el.box}`
    );
  }

  // B2: action interpreter (flow path) — understandAndLocate returns df-shaped
  // [{action, locators:[{coordinates:[y,x] 0–1000}]}]. Convert 0–1000 → 400px space.
  for (const [name, el] of Object.entries(ELEMENTS)) {
    const t0 = performance.now();
    const dfJson = await client.understandAndLocate(`tap the ${name} square`, sent.base64);
    const ms = Math.round(performance.now() - t0);
    let actions: any[];
    try {
      actions = JSON.parse(dfJson);
    } catch {
      check(`action ${name}: parseable (${ms}ms)`, false, `raw="${dfJson.slice(0, 120)}"`);
      continue;
    }
    const coords = actions?.[0]?.locators?.[0]?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      check(`action ${name}: has coordinates (${ms}ms)`, false, `df=${dfJson.slice(0, 120)}`);
      continue;
    }
    const [yNorm, xNorm] = coords; // [y, x] in 0–1000
    const center = { x: (xNorm / 1000) * 400, y: (yNorm / 1000) * 400 };
    const act = String(actions[0].action || '');
    check(
      `action ${name}: action≈tap & center inside true box (${ms}ms, action="${act}")`,
      inside(center, el.box) && /click|tap|touch|select/.test(act),
      `center=(${center.x.toFixed(0)},${center.y.toFixed(0)}) true=${el.box}`
    );
  }
}

async function partC(): Promise<void> {
  const baseUrl = (process.env.STARK_VISION_BASE_URL || '').trim();
  const model = (process.env.STARK_VISION_MODEL || '').trim();
  if (!baseUrl || !model) return; // already noted as skipped in Part B

  console.log('\n── Part C: visibility gate (absent element must NOT ground) ──');
  const client = new QwenVisionClient({ baseUrl, model });
  const raw = await makeTestImage();
  const sent = await downscaleForVision(raw);

  const grounded = async (instruction: string): Promise<boolean> => {
    const df = await client.understandAndLocate(instruction, sent.base64);
    const loc = JSON.parse(df)?.[0]?.locators?.[0];
    return !!loc && Array.isArray(loc.coordinates);
  };

  // NOTE: the synthetic image is abstract colored squares — a poor canvas for
  // testing semantic visibility judgments (Qwen may match a vague "icon" request
  // to a square). We assert only the clear cases; real-UI negative behavior is
  // validated on-device. The gate *mechanism* is unit-tested in Part A.
  check('present "red square" grounds', await grounded('tap the red square'));
  check('absent "logout button" does NOT ground', !(await grounded('tap the logout button')));
}

async function main(): Promise<void> {
  await partA();
  await partB();
  await partC();
  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
