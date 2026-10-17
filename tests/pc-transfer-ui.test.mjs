import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const { JSDOM } = require('jsdom');
const file = new URL('../ui/pc-transfer-settings-20261011.js', import.meta.url);
const defaults = { ffmpegMaxFileMb: 64, ffmpegMaxTotalMb: 96, sceneMaxFileMb: 400, siglipMaxImageMb: 20 };
function fixture(path = '/custom') {
  const dom = new JSDOM('<pc-boost-settings><section class="vf-pc-boost"><form data-existing-worker></form><form data-bandwidth-form></form></section></pc-boost-settings>', {
    url: `https://vidforge.example${path}`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  dom.window.fetch = () => new Promise(() => {});
  dom.window.MutationObserver = class { observe() {} disconnect() {} };
  if (fs.existsSync(file)) dom.window.eval(fs.readFileSync(file, 'utf8'));
  return { dom, element: dom.window.document.querySelector('pc-transfer-settings') };
}
test('separate size controls mount under PC Boost without replacing its forms', () => {
  const { dom, element } = fixture();
  try {
    assert.ok(element, 'Four file-size controls are missing');
    assert.ok(dom.window.document.querySelector('[data-existing-worker]'));
    assert.ok(dom.window.document.querySelector('[data-bandwidth-form]'));
    for (const key of Object.keys(defaults)) {
      const input = element.querySelector(`[name="${key}"]`);
      assert.equal(input.type, 'number');
      assert.equal(input.min, '1');
      assert.equal(input.max, key === 'siglipMaxImageMb' ? '128' : '4096');
    }
    assert.equal(element.form.querySelector('fieldset').disabled, true);
  } finally { dom.window.close(); }
});
test('settings are not mounted on jobs pages', () => {
  const { dom, element } = fixture('/jobs/example');
  try { assert.equal(element, null); } finally { dom.window.close(); }
});
test('current values, pending readback, and dirty edits are rendered honestly', () => {
  const { dom, element } = fixture();
  try {
    assert.ok(element);
    element.accept({ limits: defaults, status: 'defaults', workers: {} });
    for (const [key, value] of Object.entries(defaults)) assert.equal(element.form.elements.namedItem(key).value, String(value));
    element.dirty.add('siglipMaxImageMb');
    element.form.elements.namedItem('siglipMaxImageMb').value = '30';
    element.accept({ limits: { ...defaults, siglipMaxImageMb: 32 }, status: 'pending', workers: {
      siglip: { observed: defaults }, ffmpeg: { observed: defaults } } });
    assert.equal(element.form.elements.namedItem('siglipMaxImageMb').value, '30');
    assert.match(element.querySelector('[data-transfer-state]').textContent, /pending/i);
    assert.match(element.querySelector('[data-transfer-worker="siglip"]').textContent, /20/);
    element.accept({ limits: { ...defaults, siglipMaxImageMb: 32 }, status: 'active', workers: {
      siglip: { observed: { ...defaults, siglipMaxImageMb: 32 } } } }, true);
    assert.equal(element.form.elements.namedItem('siglipMaxImageMb').value, '32');
    assert.match(element.querySelector('[data-transfer-state]').textContent, /active/i);
  } finally { dom.window.close(); }
});
test('save sends only dirty size fields with a current CSRF token', async () => {
  const { dom, element } = fixture();
  try {
    assert.ok(element);
    element.accept({ limits: defaults, status: 'defaults', workers: {} });
    element.form.elements.namedItem('sceneMaxFileMb').value = '512';
    element.dirty.add('sceneMaxFileMb');
    const calls = [];
    element.request = async (url, options) => {
      calls.push({ url, options });
      return url === '/api/me' ? { csrfToken: 'fixture-csrf' } : { limits: { ...defaults, sceneMaxFileMb: 512 }, status: 'pending', workers: {} };
    };
    await element.save();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, '/api/pc-boost/transfer-limits');
    assert.equal(calls[1].options.headers['x-csrf-token'], 'fixture-csrf');
    assert.deepEqual(JSON.parse(calls[1].options.body), { sceneMaxFileMb: 512 });
    assert.equal(element.dirty.size, 0);
    assert.match(element.querySelector('[data-transfer-message]').textContent, /pending/i);
  } finally { dom.window.close(); }
});
test('failed fetch preserves dirty values and exposes the error rather than a success', async () => {
  const { dom, element } = fixture();
  try {
    assert.ok(element);
    element.accept({ limits: defaults, status: 'defaults', workers: {} });
    element.form.elements.namedItem('ffmpegMaxFileMb').value = '100';
    element.dirty.add('ffmpegMaxFileMb');
    element.request = async () => { throw new Error('Settings route unavailable'); };
    await element.save();
    assert.equal(element.dirty.size, 1);
    assert.equal(element.form.elements.namedItem('ffmpegMaxFileMb').value, '100');
    assert.match(element.querySelector('[data-transfer-message]').textContent, /unavailable/);
  } finally { dom.window.close(); }
});

test('receiver readiness never hides pending sender deployment and editable limits remain untouched', () => {
  const { dom, element } = fixture();
  try {
    element.accept({ limits: defaults, status: 'defaults', senderActivation: { ffmpeg: false, scenes: false, siglip: true },
      workers: { ffmpeg: { observed: defaults }, siglip: { observed: defaults } } });
    assert.equal(element.form.elements.namedItem('sceneMaxFileMb').value, '400');
    assert.equal(element.form.querySelector('fieldset').disabled, false);
    assert.match(element.querySelector('[data-transfer-worker="ffmpeg"]').textContent, /receiver ready; sender update pending deployment/i);
    assert.doesNotMatch(element.querySelector('[data-transfer-worker="siglip"]').textContent, /pending deployment/i);
    element.form.elements.namedItem('sceneMaxFileMb').value = '512';
    element.dirty.add('sceneMaxFileMb');
    element.accept({ limits: defaults, status: 'server_reload_pending', senderActivation: { ffmpeg: false, scenes: false, siglip: true },
      workers: { ffmpeg: { observed: defaults }, siglip: { observed: defaults } } });
    assert.match(element.querySelector('[data-transfer-state]').textContent, /pending deployment/i);
    assert.equal(element.form.elements.namedItem('sceneMaxFileMb').value, '512');
    assert.equal(element.form.querySelector('button[type="submit"]').disabled, false);
  } finally { dom.window.close(); }
});

test('pending sender save reports deployment pending without claiming active or disabling future edits', async () => {
  const { dom, element } = fixture();
  try {
    element.accept({ limits: defaults, status: 'defaults', workers: {} });
    element.form.elements.namedItem('sceneMaxFileMb').value = '512';
    element.dirty.add('sceneMaxFileMb');
    element.request = async url => url === '/api/me' ? { csrfToken: 'fixture-csrf' } : {
      limits: { ...defaults, sceneMaxFileMb: 512 }, status: 'server_reload_pending',
      senderActivation: { ffmpeg: false, scenes: false, siglip: true }, workers: {} };
    await element.save();
    assert.match(element.querySelector('[data-transfer-message]').textContent, /pending deployment/i);
    assert.equal(element.form.elements.namedItem('sceneMaxFileMb').value, '512');
    assert.equal(element.form.querySelector('fieldset').disabled, false);
    assert.doesNotMatch(element.querySelector('[data-transfer-state]').textContent, /active/i);
  } finally { dom.window.close(); }
});

test('successful refresh clears only its previous timeout and retains a dirty draft', async () => {
  const { dom, element } = fixture();
  try {
    element.refreshing = false;
    element.request = async () => { const error = new Error('fixture timeout'); error.name = 'AbortError'; throw error; };
    await element.refresh();
    assert.equal(element.querySelector('[data-transfer-message]').textContent, 'Status request timed out.');
    element.form.elements.namedItem('sceneMaxFileMb').value = '512';
    element.dirty.add('sceneMaxFileMb');
    element.request = async () => ({ limits: defaults, status: 'defaults', workers: {} });
    await element.refresh();
    assert.equal(element.querySelector('[data-transfer-message]').textContent, '');
    assert.equal(element.form.elements.namedItem('sceneMaxFileMb').value, '512');
    assert.equal(element.dirty.has('sceneMaxFileMb'), true);
    assert.equal(element.form.querySelector('button[type="submit"]').disabled, false);
  } finally { dom.window.close(); }
});

test('late refresh cannot clear a newer save message or overwrite its state', async () => {
  const { dom, element } = fixture();
  try {
    element.refreshing = false;
    let resolve;
    element.request = async () => new Promise(done => { resolve = done; });
    const pending = element.refresh();
    element.sequence++;
    element.busy = true;
    element.querySelector('[data-transfer-message]').textContent = 'Saving';
    resolve({ limits: defaults, status: 'defaults', workers: {} });
    await pending;
    assert.equal(element.querySelector('[data-transfer-message]').textContent, 'Saving');
    assert.equal(element.state, undefined);
  } finally { dom.window.close(); }
});

test('a successful status refresh does not erase a previous save error', async () => {
  const { dom, element } = fixture();
  try {
    element.refreshing = false;
    element.querySelector('[data-transfer-message]').textContent = 'File sizes could not be saved.';
    element.refreshError = false;
    element.request = async () => ({ limits: defaults, status: 'defaults', workers: {} });
    await element.refresh();
    assert.equal(element.querySelector('[data-transfer-message]').textContent, 'File sizes could not be saved.');
  } finally { dom.window.close(); }
});
