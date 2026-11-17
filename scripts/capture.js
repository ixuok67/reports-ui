#!/usr/bin/env node
'use strict';

// Regenerates the README media from the fictional demo reports:
//   docs/{reader,search,pr-digest,mobile}.png and docs/tour.gif
// Usage: npm run capture [-- --frames <dir>]   (--frames also saves each GIF frame as a PNG)
// Dev dependencies: puppeteer, gifenc, pngjs.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const PORT = 4402;
const BASE = `http://127.0.0.1:${PORT}/`;
const FRAMES_DIR = process.argv.includes('--frames') ? process.argv[process.argv.indexOf('--frames') + 1] : null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, REPORTS_HOME: path.join(ROOT, 'demo', 'reports'), PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + 'api/index')).ok) return child;
    } catch {}
    await wait(100);
  }
  child.kill();
  throw new Error('demo server did not start');
}

async function newPage(browser, width, height, scale) {
  const ctx = await browser.createBrowserContext(); // fresh storage: same "first visit" every run
  const page = await ctx.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  return { ctx, page };
}

async function stills(browser) {
  const shot = async (name, w, h, scale, url, act) => {
    const { ctx, page } = await newPage(browser, w, h, scale);
    await page.goto(url, { waitUntil: 'networkidle0' });
    if (act) await act(page);
    await wait(600);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    await ctx.close();
  };
  await shot('reader', 1440, 900, 2, BASE);
  await shot('search', 1440, 900, 2, BASE, (p) => p.type('#q', 'postgres'));
  await shot('pr-digest', 1440, 900, 2, BASE, (p) => p.click('[data-kind="pr-digest"]'));
  await shot('mobile', 390, 844, 2, BASE + '#daily-reports/2026/2026-11-16.md');
}

async function tour(browser) {
  const W = 1280;
  const H = 800;
  const { ctx, page } = await newPage(browser, W, H, 1);
  const gif = GIFEncoder();
  let frames = 0;

  // Each frame gets its own 256-colour palette; the dark UI has few colours, so this stays crisp.
  const frame = async (holdMs) => {
    const buf = await page.screenshot({ type: 'png' });
    if (FRAMES_DIR) fs.writeFileSync(path.join(FRAMES_DIR, `frame-${String(frames).padStart(2, '0')}.png`), buf);
    const png = PNG.sync.read(buf);
    const palette = quantize(png.data, 256);
    gif.writeFrame(applyPalette(png.data, palette), W, H, { palette, delay: holdMs });
    frames++;
  };
  const settle = () => wait(450);

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await settle();
  await frame(2200); // newest report, all kinds

  await page.keyboard.press('j');
  await settle();
  await frame(1300);
  await page.keyboard.press('j');
  await settle();
  await frame(1300);

  await page.click('[data-kind="pr-digest"]');
  await settle();
  await frame(1600);
  await page.click('[data-group="orbit-api"]');
  await settle();
  await frame(1600);

  await page.click('[data-kind="all"]');
  await page.click('#q');
  for (const ch of 'postgres') {
    await page.keyboard.type(ch);
    await wait(60);
    await frame(110);
  }
  await wait(500);
  await frame(2000);
  await page.click('.item:nth-of-type(2)'); // second hit: the news story
  await settle();
  await frame(1600);

  await page.keyboard.press('Escape');
  await page.goto(BASE + '#daily-reports/2026/2026-11-16.md', { waitUntil: 'networkidle0' });
  await page.keyboard.press('f');
  await settle();
  await frame(1800);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => document.querySelector('#scroll').scrollBy(0, 160));
    await wait(80);
    await frame(140);
  }
  await frame(1600);
  await page.keyboard.press('f');
  await settle();
  await frame(1800);

  gif.finish();
  fs.writeFileSync(path.join(OUT, 'tour.gif'), gif.bytes());
  await ctx.close();
  return frames;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (FRAMES_DIR) fs.mkdirSync(FRAMES_DIR, { recursive: true });
  const server = await startServer();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    await stills(browser);
    const n = await tour(browser);
    const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
    console.log(`docs/tour.gif: ${n} frames, ${kb('tour.gif')} KB`);
    for (const f of ['reader', 'search', 'pr-digest', 'mobile']) console.log(`docs/${f}.png: ${kb(f + '.png')} KB`);
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
