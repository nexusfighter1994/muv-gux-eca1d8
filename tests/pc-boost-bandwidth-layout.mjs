import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as api from '../node/pc-boost-api.mjs';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const { chromium } = require('playwright');
const source = fs.readFileSync(new URL('../ui/pc-boost-settings-20261002.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../ui/pc-boost-settings-20261002.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = new URL('./evidence/', import.meta.url);
fs.mkdirSync(evidence, { recursive: true });
try {
  for (const width of [360, 390, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/pc-boost/bandwidth') return route.fulfill({ json: {
        desired: null, observed: { downMbit: 120, upMbit: 37 }, status: 'unmanaged', bounds: api.BANDWIDTH_BOUNDS,
      } });
      if (url.pathname === '/api/pc-boost') return route.fulfill({ json: {
        config: api.DEFAULT_CONFIG, bounds: api.CONFIG_BOUNDS,
        health: { checkedAt: new Date().toISOString() }, boost: { ffmpeg: 0, clipvault: 0 },
      } });
      if (url.pathname !== '/custom') return route.abort();
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        :root{--vc-border:#d5dadd;--vc-text:#20292d;--vc-text-dim:#54636a;--vc-text-faint:#65757c;--vc-ok:#27794a;--vc-accent:#248264}
        *{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;background:#fff}main{max-width:960px;margin:0 auto;padding:16px 20px}
        .vc-input{padding:8px;border:1px solid #c1cbd0}.vc-btn{padding:8px 12px;border:1px solid #c1cbd0;background:#eef2f3;color:#20292d}.vc-btn--primary{background:#248264;color:#fff}.vc-muted{color:#54636a}
        ${css}</style></head><body><main><h1>Custom</h1><div id="engine-health"></div></main><script>${source}</script></body></html>` });
    });
    await page.goto('https://vidforge.example/custom');
    await page.waitForFunction(() => document.querySelector('[name="downMbit"]').value === '120');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `no overflow at ${width}px`);
    for (const key of ['cpuWorkers', 'gpuWorkers', 'siglipConcurrency', 'sceneWorkers']) {
      assert.equal(await page.locator(`[name="${key}"]`).getAttribute('max'), '25');
    }
    assert.deepEqual(errors, [], `no browser errors at ${width}px`);
    if ([390, 1280].includes(width)) await page.screenshot({ path: new URL(`bandwidth-${width}.png`, evidence).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true });
    await page.close();
    console.log(`PASS isolated layout ${width}px: numeric controls, no overflow, no browser errors`);
  }
} finally { await browser.close(); }
