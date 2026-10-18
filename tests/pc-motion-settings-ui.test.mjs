import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(new URL('../ui/pc-boost-settings-20261002.js', import.meta.url), 'utf8');
const config = {enabled:true,cpuWorkers:18,gpuWorkers:6,siglipEnabled:true,siglipConcurrency:14,sceneWorkers:0,clipvaultBoost:35,ffmpegBoost:14};

function page() {
  const dom = new JSDOM('<div id="engine-health"></div>', {url:'https://vidforge.example.invalid/custom',runScripts:'outside-only',pretendToBeVisual:true});
  dom.window.fetch = () => new Promise(() => {});
  dom.window.MutationObserver = class {observe() {}};
  dom.window.eval(source);
  return {dom, settings: dom.window.document.querySelector('pc-boost-settings')};
}

test('Home motion slots and time share are editable PC Boost settings with bounds', () => {
  const {dom, settings} = page();
  try {
    settings.accept({config: {...config, motionSlots: 3, motionHomeShare: 85}});
    const slots = settings.form.elements.namedItem('motionSlots'), share = settings.form.elements.namedItem('motionHomeShare');
    assert.equal(slots.value, '3');
    assert.equal(share.value, '85');
    assert.equal([slots.min, slots.max].join(), '1,8');
    assert.equal([share.min, share.max].join(), '50,200');
    assert.match(settings.textContent, /Parallel motion graphics/);
    assert.match(settings.textContent, /Home PC time share/);
  } finally {dom.window.close();}
});

test('an older server without motion keys shows the fixed behaviour (2 slots, 70 %)', () => {
  const {dom, settings} = page();
  try {
    settings.accept({config});
    assert.equal(settings.form.elements.namedItem('motionSlots').value, '2');
    assert.equal(settings.form.elements.namedItem('motionHomeShare').value, '70');
  } finally {dom.window.close();}
});

test('only a changed motion field is sent in the PATCH', async () => {
  const {dom, settings} = page();
  try {
    settings.accept({config: {...config, motionSlots: 2, motionHomeShare: 70}});
    const slots = settings.form.elements.namedItem('motionSlots');
    slots.value = '4';
    slots.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
    slots.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    assert.ok(settings.dirty.has('motionSlots'));
    assert.ok(!settings.dirty.has('motionHomeShare'));
  } finally {dom.window.close();}
});

test('RunPod burst: toggle, thresholds, price cap and a write-only API key field with live status', () => {
  const {dom, settings} = page();
  try {
    settings.accept({config: {...config, burstEnabled: true, burstStartQueue: 150, burstStopQueue: 5, burstMaxCents: 30, burstMaxHours: 8, burstApiKeySet: true,
      burstStatus: {pod: {id: 'p1', gpu: 'NVIDIA RTX A4000', costPerHr: 0.17, ready: true}, inflight: 2, queued: 233, ledger: {seconds: 5400, cents: 25.5}}}});
    const f = name => settings.form.elements.namedItem(name);
    assert.equal(f('burstEnabled').checked, true);
    assert.equal([f('burstStartQueue').value, f('burstStopQueue').value, f('burstMaxCents').value, f('burstMaxHours').value].join(), '150,5,30,8');
    assert.equal(f('burstApiKey').type, 'password');
    assert.equal(f('burstApiKey').value, '', 'the key is never filled in');
    assert.match(f('burstApiKey').placeholder, /saved/);
    const state = settings.querySelector('[data-burst-state]').textContent;
    assert.match(state, /Pod ready: NVIDIA RTX A4000 at \$0\.17\/h, 2 rendering/);
    assert.match(state, /233 graphics queued/);
    assert.match(state, /today 1\.5 h, \$0\.26/);
    settings.accept({config});
    assert.equal(f('burstEnabled').checked, false, 'older server: off');
    assert.match(f('burstApiKey').placeholder, /not set/);
  } finally {dom.window.close();}
});

test('RunPod GPU types: checkbox list from the live catalog, marks prices above the cap, sends the checked list', () => {
  const {dom, settings} = page();
  try {
    const gpus = [{id: 'NVIDIA RTX 4090', name: 'RTX 4090', memoryInGb: 24, price: 0.69}, {id: 'NVIDIA RTX A4000', name: 'RTX A4000', memoryInGb: 16, price: 0.17}];
    settings.accept({config: {...config, burstMaxCents: 30, burstGpuTypes: ['NVIDIA RTX A4000', 'Gone GPU'], burstStatus: {gpus, ledger: {seconds: 0, cents: 0}}}});
    const boxes = [...settings.querySelectorAll('input[name="burstGpuType"]')];
    assert.deepEqual(boxes.map(b => [b.value, b.checked]), [['NVIDIA RTX 4090', false], ['NVIDIA RTX A4000', true], ['Gone GPU', true]]);
    const text = settings.querySelector('[data-burst-gpus]').textContent;
    assert.match(text, /RTX 4090 · 24 GB · \$0\.69\/h \(above the cap\)/);
    assert.match(text, /RTX A4000 · 16 GB · \$0\.17\/h(?! \(above)/);
    assert.match(text, /Gone GPU · not offered now/);
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new dom.window.Event('input', {bubbles: true}));
    assert.ok(settings.dirty.has('burstGpuTypes'));
  } finally {dom.window.close();}
});
