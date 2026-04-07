#!/usr/bin/env node
/**
 * Captures the demo animation as a GIF using Puppeteer + ffmpeg.
 *
 * Usage: npx puppeteer browsers install chrome && node landing/capture-gif.mjs
 */
import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = join(__dirname, '.frames');
const OUTPUT_GIF = join(__dirname, 'demo.gif');
const HTML_FILE = join(__dirname, 'demo-animation.html');

const FPS = 15;
const FRAME_INTERVAL = 1000 / FPS;
const DURATION_SEC = 18; // full loop duration
const TOTAL_FRAMES = FPS * DURATION_SEC;

async function main() {
  // Dynamic import puppeteer
  let puppeteer;
  try {
    puppeteer = await import('puppeteer');
  } catch {
    console.log('Installing puppeteer...');
    execSync('npm install --no-save puppeteer', { stdio: 'inherit' });
    puppeteer = await import('puppeteer');
  }

  // Clean up frames dir
  if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  console.log(`Capturing ${TOTAL_FRAMES} frames at ${FPS} fps...`);

  const browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 760, deviceScaleFactor: 2 });
  await page.goto(`file://${HTML_FILE}`, { waitUntil: 'networkidle0' });

  // Wait for fonts to load
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 500));

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const frameNum = String(i).padStart(4, '0');
    await page.screenshot({
      path: join(FRAMES_DIR, `frame-${frameNum}.png`),
      clip: { x: 0, y: 0, width: 360, height: 760 },
    });

    // Wait for next frame
    await new Promise((r) => setTimeout(r, FRAME_INTERVAL));

    if (i % 30 === 0) {
      console.log(`  Frame ${i}/${TOTAL_FRAMES}`);
    }
  }

  await browser.close();
  console.log(`Captured ${TOTAL_FRAMES} frames.`);

  // Convert to GIF using ffmpeg with good quality palette
  console.log('Generating GIF with ffmpeg...');

  const palettePath = join(FRAMES_DIR, 'palette.png');

  // Generate palette for better color quality
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame-%04d.png" ` +
      `-vf "fps=${FPS},scale=360:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" ` +
      `"${palettePath}"`,
    { stdio: 'pipe' }
  );

  // Generate GIF using palette
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame-%04d.png" ` +
      `-i "${palettePath}" ` +
      `-lavfi "fps=${FPS},scale=360:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3" ` +
      `"${OUTPUT_GIF}"`,
    { stdio: 'pipe' }
  );

  // Clean up frames
  rmSync(FRAMES_DIR, { recursive: true });

  // Report size
  const { statSync } = await import('fs');
  const size = statSync(OUTPUT_GIF).size;
  console.log(`\n✅ GIF saved: ${OUTPUT_GIF}`);
  console.log(`   Size: ${(size / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
