#!/usr/bin/env node
/**
 * Captures the parallel-run demo animation as a GIF.
 *
 * Usage:
 *   node landing/capture-parallel-gif.mjs
 *
 * Requires: ffmpeg in PATH.
 * Puppeteer is auto-installed if missing.
 */
import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = join(__dirname, '.frames-parallel');
const OUTPUT_GIF = join(__dirname, 'parallel-demo.gif');
const HTML_FILE = join(__dirname, 'parallel-demo.html');

// Animation: 4 devices connect, 9 steps each (staggered), hold result, fade
const FPS = 15;
const DURATION_SEC = 22;
const TOTAL_FRAMES = FPS * DURATION_SEC;
const FRAME_MS = 1000 / FPS;

// Panel dimensions (must match parallel-demo.html body size)
const WIDTH = 720;
const HEIGHT = 600;

async function main() {
  // Auto-install puppeteer if needed
  let puppeteer;
  try {
    puppeteer = await import('puppeteer');
  } catch {
    console.log('Installing puppeteer…');
    execSync('npm install --no-save puppeteer', { stdio: 'inherit' });
    puppeteer = await import('puppeteer');
  }

  // Prep frames directory
  if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  console.log(`Capturing ${TOTAL_FRAMES} frames at ${FPS} fps (${DURATION_SEC}s)…`);

  const browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
  await page.goto(`file://${HTML_FILE}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 600)); // let initial render settle

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const frameNum = String(i).padStart(4, '0');
    await page.screenshot({
      path: join(FRAMES_DIR, `frame-${frameNum}.png`),
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      omitBackground: false,
    });
    await new Promise((r) => setTimeout(r, FRAME_MS));
    if (i % 30 === 0) console.log(`  frame ${i}/${TOTAL_FRAMES}`);
  }

  await browser.close();
  console.log(`Captured ${TOTAL_FRAMES} frames. Generating GIF…`);

  const palette = join(FRAMES_DIR, 'palette.png');

  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame-%04d.png" ` +
      `-vf "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" ` +
      `"${palette}"`,
    { stdio: 'pipe' }
  );

  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame-%04d.png" ` +
      `-i "${palette}" ` +
      `-lavfi "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3" ` +
      `"${OUTPUT_GIF}"`,
    { stdio: 'pipe' }
  );

  rmSync(FRAMES_DIR, { recursive: true });

  const size = statSync(OUTPUT_GIF).size;
  console.log(`\n✅  ${OUTPUT_GIF}`);
  console.log(`   ${(size / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
