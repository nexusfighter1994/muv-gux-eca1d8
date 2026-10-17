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
    assert.equal([slots.min, slots.max].join(), '1,4');
    assert.equal([share.min, share.max].join(), '50,90');
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
