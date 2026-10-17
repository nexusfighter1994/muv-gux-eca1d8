import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('../ui/pc-boost-settings-20261002.js', import.meta.url), 'utf8');
const config = { enabled: true, cpuWorkers: 18, gpuWorkers: 6, siglipEnabled: true,
  siglipConcurrency: 14, sceneWorkers: 0, clipvaultBoost: 35, ffmpegBoost: 14 };
const ffmpeg = { reachable: true, ready: true, reason: 'ready', gpuAvailable: true, nvencReady: true,
  cpuActive: 3, cpuCapacity: 18, gpuActive: 2, gpuCapacity: 6, completedCpu: 123, completedGpu: 45 };
function fixture() {
  const dom = new JSDOM('<div id="engine-health"></div><ul>' + ['cpu', 'gpu', 'siglip'].map(key =>
    `<li data-homepc-row="${key}"><strong></strong><span class="vc-faint"></span></li>`).join('') + '</ul>', {
    url: 'https://vidforge.example/custom', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = () => new Promise(() => {});
  dom.window.MutationObserver = class { observe() {} };
  dom.window.eval(source);
  dom.window.document.querySelectorAll('[data-homepc-row]').forEach(row => row.getClientRects = () => [1]);
  const settings = dom.window.document.querySelector('pc-boost-settings');
  settings.accept({ config, health: { ffmpeg } });
  return { dom, settings, render: dom.window.eval('renderConcurrency'),
    row: key => dom.window.document.querySelector(`[data-homepc-row="${key}"]`) };
}
test('failed VidForge status requests do not falsely declare a PC disconnect', () => {
  const { dom, render, row } = fixture();
  try {
    render({ config, health: { ffmpeg } });
    render(null);
    assert.match(row('cpu').textContent, /Status unavailable/);
    assert.doesNotMatch(row('cpu').textContent, /Disconnected|server normal|3\/18 busy/);
    assert.equal(row('cpu').classList.contains('vc-worker-row--busy'), false);
    assert.match(row('gpu').querySelector('strong').textContent, /NVENC/);
  } finally { dom.window.close(); }
});
test('worker timeout is unknown, while actual offline and auth failures remain explicit', () => {
  const { dom, settings, render, row } = fixture();
  try {
    for (const [reason, label] of [['timeout', 'Status delayed'], ['offline', 'Disconnected'], ['unauthorized', 'Authentication failed']]) {
      const health = { ffmpeg: { reachable: reason === 'unauthorized', ready: false, reason } };
      render({ config, health });
      settings.renderHealth(health);
      assert.ok(row('cpu').textContent.includes(label), row('cpu').textContent);
      assert.equal(settings.querySelector('[data-state="cpu"]').textContent, label);
      assert.equal(settings.querySelector('[data-active="cpu"]').textContent, 'Unavailable');
    }
  } finally { dom.window.close(); }
});
test('old health counters are not presented as live work', () => {
  const { dom, settings, render, row } = fixture();
  try {
    const health = { checkedAt: new Date(Date.now() - 30000).toISOString(), ffmpeg };
    render({ config, health });
    settings.renderHealth(health);
    assert.match(row('cpu').textContent, /Status delayed/);
    assert.doesNotMatch(row('cpu').textContent, /3\/18 busy/);
    assert.equal(row('cpu').classList.contains('vc-worker-row--busy'), false);
    assert.equal(settings.querySelector('[data-active="cpu"]').textContent, 'Unavailable');
  } finally { dom.window.close(); }
});
test('a slow but healthy 3-second status reply survives the concurrency deadline', async () => {
  const { dom, row } = fixture();
  try {
    dom.window.fetch = (url, { signal }) => {
      if (url.endsWith('/home-queue')) return Promise.resolve({ ok: true, json: async () => ({ active: 4, capacity: 24, queued: 10 }) });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ config, health: { ffmpeg } }) }), 3000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('status deadline')); }, { once: true });
      });
    };
    await dom.window.eval('refreshConcurrency')();
    assert.match(row('cpu').textContent, /3\/18 busy/);
    assert.doesNotMatch(row('cpu').textContent, /Disconnected/);
  } finally { dom.window.close(); }
});
test('one unavailable worker never changes a healthy sibling to offline', () => {
  const { dom, render, row } = fixture();
  try {
    render({ config, health: { ffmpeg, siglip: { reachable: false, ready: false, reason: 'timeout' } } });
    assert.match(row('cpu').textContent, /3\/18 busy/);
    assert.match(row('siglip').textContent, /Status delayed/);
  } finally { dom.window.close(); }
});
