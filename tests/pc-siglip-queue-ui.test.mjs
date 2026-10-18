import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('../ui/pc-boost-settings-20261002.js', import.meta.url), 'utf8');
const config = { enabled: true, cpuWorkers: 18, gpuWorkers: 6, siglipEnabled: true,
  siglipConcurrency: 14, sceneWorkers: 0, clipvaultBoost: 35, ffmpegBoost: 14 };
const health = { siglip: { reachable: true, ready: true, gpuAvailable: true,
  active: 2, acceptedConcurrency: 14, gpuConcurrency: 1, completed: 101 } };
const homeSiglipQueue = { capacity: 25, active: 8, queued: 19, admitted: 47,
  recovering: 3, completed: 36, checkedAt: '2026-10-14T12:00:00Z' };

function fixture() {
  const rows = ['queue', 'cpu', 'gpu', 'scene', 'siglip'].map(key =>
    `<li data-homepc-row="${key}"><strong></strong><span class="vc-faint"></span></li>`).join('');
  const dom = new JSDOM(`<div id="engine-health"></div><ul>${rows}</ul>`, {
    url: 'https://vidforge.example/custom', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  dom.window.fetch = () => new Promise(() => {});
  dom.window.MutationObserver = class { observe() {} };
  dom.window.eval(source);
  return { dom, render: dom.window.eval('renderConcurrency'),
    row: dom.window.document.querySelector('[data-homepc-row="siglip"]') };
}

test('SigLIP admission and recovery counters supplement real worker telemetry', () => {
  const { dom, render, row } = fixture();
  try {
    render({ config, health, homeSiglipQueue });
    assert.equal(row.querySelector('.vc-faint').textContent,
      '2/14 busy | 101 completed (PC total) | 8/25 admitted | 19 eligible queued | 3 native recoveries');
    assert.equal(row.classList.contains('vc-worker-row--busy'), true);
  } finally { dom.window.close(); }
});

test('absent queue telemetry retains the original SigLIP row and clears old queue counters', () => {
  const { dom, render, row } = fixture();
  try {
    render({ config, health, homeSiglipQueue });
    for (const queue of [undefined, null]) {
      render({ config, health, homeSiglipQueue: queue });
      assert.equal(row.querySelector('.vc-faint').textContent,
        '2/14 busy | 101 completed (PC total)');
    }
  } finally { dom.window.close(); }
});

test('admitted Home work does not mark an idle or unavailable worker busy', () => {
  const { dom, render, row } = fixture();
  try {
    render({ config, health: { siglip: { ...health.siglip, active: 0 } }, homeSiglipQueue });
    assert.match(row.textContent, /0\/14 busy/);
    assert.match(row.textContent, /8\/25 admitted/);
    assert.equal(row.classList.contains('vc-worker-row--busy'), false);
    render({ config, homeSiglipQueue });
    assert.match(row.textContent, /Status unavailable \| Busy unavailable \| Completed unavailable/);
    assert.match(row.textContent, /3 native recoveries/);
    assert.equal(row.classList.contains('vc-worker-row--busy'), false);
  } finally { dom.window.close(); }
});

test('zero queue counters are shown and malformed counts remain unknown', () => {
  const { dom, render, row } = fixture();
  try {
    render({ config, health, homeSiglipQueue: { capacity: 14, active: 0, queued: 0, recovering: 0 } });
    assert.match(row.textContent, /0\/14 admitted \| 0 eligible queued \| 0 native recoveries/);
    render({ config, health, homeSiglipQueue: { capacity: '25', active: -1, queued: 1.5 } });
    assert.match(row.textContent, /\?\/\? admitted \| \? eligible queued \| \? native recoveries/);
  } finally { dom.window.close(); }
});

test('queue telemetry leaves sibling rows and current 14/max25 settings untouched', () => {
  const { dom, render } = fixture();
  try {
    const data = { config, health, homeQueue: { active: 12, capacity: 22, queued: 18 } };
    const siblings = [...dom.window.document.querySelectorAll('[data-homepc-row]:not([data-homepc-row="siglip"])')];
    render(data);
    const before = siblings.map(row => row.outerHTML);
    const settings = dom.window.document.querySelector('pc-boost-settings');
    settings.accept(data);
    const settingsBefore = settings.innerHTML;
    render({ ...data, homeSiglipQueue });
    assert.deepEqual(siblings.map(row => row.outerHTML), before);
    assert.equal(settings.innerHTML, settingsBefore);
    assert.equal(settings.querySelector('[name="siglipConcurrency"]').value, '14');
    for (const key of ['cpuWorkers', 'gpuWorkers', 'siglipConcurrency', 'sceneWorkers']) {
      assert.equal(settings.querySelector(`[name="${key}"]`).max, '25');
    }
  } finally { dom.window.close(); }
});

test('server SigLIP embeddings and the PC backlog are shown while the native cap reports', () => {
  const { dom, render, row } = fixture();
  try {
    render({ config, health, homeSiglipQueue, siglipServer: { embeds: 1, max: 1, waitingForPc: 1486 } });
    assert.match(row.querySelector('.vc-faint').textContent, /server 1\/1 embeddings \| 1486 waiting for PC$/);
  } finally { dom.window.close(); }
});
