import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('../ui/pc-boost-settings-20261002.js', import.meta.url), 'utf8');
test('native Home scenes show separate CPU/GPU completions without claiming old WSL slots',()=>{
  const {dom}=fixture();
  try{
    dom.window.document.body.insertAdjacentHTML('beforeend','<div data-homepc-row="scene"><strong></strong><span class="vc-faint"></span></div>');
    dom.window.eval('renderConcurrency('+JSON.stringify({homeQueue:{scenes:{gpu:7,cpu:3,fallback:2}},health:{checkedAt:new Date().toISOString(),ffmpeg:{ready:true,reachable:true,sceneReady:false}}})+')');
    const row=dom.window.document.querySelector('[data-homepc-row="scene"]');
    assert.match(row.textContent,/GPU decode/);assert.match(row.textContent,/7 GPU \+ 3 CPU completed/);
    assert.doesNotMatch(row.textContent,/Not ready|busy/);
  }finally{dom.window.close();}
});
function fixture(fetchImpl = () => new Promise(() => {})) {
  const dom = new JSDOM('<div id="engine-health"></div>', {
    url: 'https://vidforge.example/custom', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  dom.window.fetch = fetchImpl;
  // An unresolved fetch cannot make assertions depend on network timing.
  dom.window.MutationObserver = class { observe() {} disconnect() {} };
  dom.window.eval(source);
  return { dom, element: dom.window.document.querySelector('pc-boost-settings') };
}
test('all four settings inputs advertise 25 while bandwidth has directional total caps and an honest uncapped option', () => {
  const { dom, element } = fixture();
  try {
    for (const key of ['cpuWorkers', 'gpuWorkers', 'siglipConcurrency', 'sceneWorkers']) {
      assert.equal(element.querySelector(`[name="${key}"]`).max, '25');
    }
    for (const key of ['downMbit', 'upMbit']) {
      const input = element.querySelector(`[name="${key}"]`);
      assert.ok(input);
      assert.equal(input.type, 'number');
      assert.equal(input.max, '1000');
    }
    assert.equal(element.querySelector('[data-uncapped]').disabled, true);
  } finally { dom.window.close(); }
});
test('bandwidth status separates pending desired caps from actual kernel-shaper readback', () => {
  const { dom, element } = fixture();
  try {
    assert.equal(typeof element.acceptBandwidth, 'function');
    element.acceptBandwidth({ desired: { downMbit: 80, upMbit: 25 }, observed: { downMbit: 120, upMbit: 37 },
      status: 'pending', bounds: { min: 1, max: 1000 } });
    assert.match(element.querySelector('[data-bandwidth-state]').textContent, /pending/i);
    element.bandwidthDirty.add('upMbit');
    element.querySelector('[name="upMbit"]').value = '30';
    element.acceptBandwidth({ desired: { downMbit: 80, upMbit: 25 }, observed: { downMbit: 80, upMbit: 25 },
      status: 'active', bounds: { min: 1, max: 1000 } });
    assert.equal(element.querySelector('[name="upMbit"]').value, '30');
    assert.match(element.querySelector('[data-bandwidth-state]').textContent, /tunnel limit active/i);
  } finally { dom.window.close(); }
});
test('bandwidth save sends only directional caps with CSRF and leaves worker selections alone', async () => {
  const { dom, element } = fixture();
  try {
    const config = { enabled: true, cpuWorkers: 8, gpuWorkers: 4, siglipEnabled: true,
      siglipConcurrency: 3, sceneWorkers: 5, clipvaultBoost: 40, ffmpegBoost: 0 };
    element.accept({ config });
    element.acceptBandwidth({ desired: null, observed: { downMbit: 120, upMbit: 37 }, status: 'unmanaged' });
    element.querySelector('[name="downMbit"]').value = '80';
    element.querySelector('[name="upMbit"]').value = '25';
    element.bandwidthDirty.add('downMbit');
    element.bandwidthDirty.add('upMbit');
    const calls = [];
    element.request = async (url, options) => {
      calls.push({ url, options });
      return url === '/api/me' ? { csrfToken: 'fixture-csrf' } : {
        desired: { downMbit: 80, upMbit: 25 }, status: 'pending' };
    };
    await element.saveBandwidth();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, '/api/pc-boost/bandwidth');
    assert.equal(calls[1].options.headers['x-csrf-token'], 'fixture-csrf');
    assert.deepEqual(JSON.parse(calls[1].options.body), { downMbit: 80, upMbit: 25 });
    assert.deepEqual(element.config, config);
    assert.equal(element.bandwidthDirty.size, 0);
    assert.match(element.querySelector('[data-bandwidth-message]').textContent, /Pending tunnel sync/);
    element.querySelector('[name="cpuWorkers"]').value = '26';
    assert.equal(element.form.checkValidity(), false);
  } finally { dom.window.close(); }
});
test('auto refresh cannot invalidate a bandwidth save in progress', async () => {
  const { dom, element } = fixture();
  try {
    element.refreshing = false;
    element.bandwidthBusy = true;
    const sequence = element.sequence;
    let called = false;
    element.request = async () => { called = true; return {}; };
    await element.refresh();
    assert.equal(called, false);
    assert.equal(element.sequence, sequence);
  } finally { dom.window.close(); }
});
test('GPU decode telemetry is live while SigLIP GPU and scene CPU stay available', () => {
  const { dom, element } = fixture();
  try {
    element.config = { enabled: true, siglipEnabled: true };
    element.renderHealth({ checkedAt: new Date().toISOString(), ffmpeg: {
      reachable: true, ready: true, gpuAvailable: true, cpuActive: 2, gpuActive: 4, sceneReady: true, sceneActive: 3,
    }, siglip: { reachable: true, ready: true, gpuAvailable: true, active: 1 } });
    assert.equal(element.querySelector('[data-state="gpu"]').textContent, 'Reachable');
    assert.equal(element.querySelector('[data-active="gpu"]').textContent, '4');
    assert.equal(element.querySelector('[data-state="siglip"]').textContent, 'Reachable');
    assert.equal(element.querySelector('[data-active="siglip"]').textContent, '1');
    assert.equal(element.querySelector('[data-active="scene"]').textContent, '3');
  } finally { dom.window.close(); }
});

test('known defaults prefill editable fields while an offline limiter never claims them active', () => {
  const { dom, element } = fixture();
  try {
    element.acceptBandwidth({ desired: null, observed: null, defaults: { downMbit: 120, upMbit: 37 },
      status: 'bridge_offline', bounds: { min: 1, max: 1000 } });
    assert.equal(element.querySelector('[name="downMbit"]').value, '120');
    assert.equal(element.querySelector('[name="upMbit"]').value, '37');
    assert.match(element.querySelector('[data-bandwidth-defaults]').textContent, /120.*37/);
    assert.match(element.querySelector('[data-bandwidth-state]').textContent, /not active/i);
    assert.equal(element.querySelector('[name="downMbit"]').disabled, false);
  } finally { dom.window.close(); }
});
