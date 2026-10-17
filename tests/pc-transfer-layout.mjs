import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TRANSFER_LIMITS, TRANSFER_BOUNDS } from '../node/pc-transfer-api.mjs';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const { chromium } = require('playwright');
const source = fs.readFileSync(new URL('../ui/pc-transfer-settings-20261011.js', import.meta.url), 'utf8');
const css = ['../ui/pc-boost-settings-20261002.css', '../ui/pc-transfer-settings-20261011.css']
  .map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const evidence = fileURLToPath(new URL('./evidence/', import.meta.url));
fs.mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [360, 390, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/pc-boost/transfer-limits') return route.fulfill({ json: {
        limits: DEFAULT_TRANSFER_LIMITS, bounds: TRANSFER_BOUNDS, units: 'MiB', status: 'server_reload_pending',
        senderActivation: { ffmpeg: false, scenes: false, siglip: true },
        workers: { ffmpeg: { observed: DEFAULT_TRANSFER_LIMITS }, siglip: { observed: DEFAULT_TRANSFER_LIMITS } },
      } });
      if (url.pathname !== '/custom') return route.abort();
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        :root{--vc-border:#333;--vc-text:#eee;--vc-text-dim:#bbb;--vc-accent:#6dc59a}*{box-sizing:border-box}
        body{margin:0;background:#151718;color:#eee;font-family:Arial,sans-serif}main{max-width:980px;margin:auto;padding:16px 20px}
        .vc-input{padding:8px;border:1px solid #555;background:#202426;color:#eee}.vc-btn{padding:8px 12px;border:1px solid #555;background:#252a2c;color:#eee}
        ${css}</style></head><body><main><h1>Custom</h1><pc-boost-settings><section class="vf-pc-boost"><h2>PC Boost</h2></section></pc-boost-settings></main><script>${source}</script></body></html>` });
    });
    await page.goto('https://vidforge.example/custom');
    await page.waitForFunction(() => document.querySelector('[name="ffmpegMaxFileMb"]').value === '64');
    assert.match(await page.locator('[data-transfer-state]').textContent(), /pending deployment/i);
    assert.match(await page.locator('[data-transfer-worker="ffmpeg"]').textContent(), /receiver ready; sender update pending deployment/i);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow at ${width}`);
    for (const key of Object.keys(DEFAULT_TRANSFER_LIMITS)) {
      assert.equal(await page.locator(`[name="${key}"]`).inputValue(), String(DEFAULT_TRANSFER_LIMITS[key]));
      const bounds = await page.locator(`[name="${key}"]`).boundingBox();
      assert.ok(bounds.width > 50 && bounds.x >= 0 && bounds.x + bounds.width <= width, `${key} fits ${width}px`);
    }
    assert.deepEqual(errors, []);
    if ([390, 1280].includes(width)) await page.screenshot({ path: path.join(evidence, `transfer-${width}.png`), fullPage: true });
    await page.close();
    console.log(`PASS isolated transfer layout ${width}px: current MiB values, no overflow, no browser errors`);
  }
} finally { await browser.close(); }
