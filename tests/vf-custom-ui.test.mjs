import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('../ui/vf-custom-page.js', import.meta.url), 'utf8');
const defaults = { maxActiveVideos: 15, autoRetryFailed: 3, surplusAttempts: 5, surplusIgnoreBreaker: true,
  surplusFirst: true, surplusRetryMinSec: 10, surplusRetryMaxSec: 20, surplusInsertEfforts: ['low', 'medium', 'high'] };
const groupTitles = ['Produktion', 'LLM/Provider', 'Rendering', 'Home-PC', 'Sicherheit'];
const groups = ['production', 'providers', 'rendering', 'home', 'safety'].map((id, i) => ({ id, title: groupTitles[i] }));
const mod = (id, group, hooks = []) => ({ id, group, title: id, description: `Description ${id}`, enabled: true,
  effective: true, restartRequired: true, pendingRestart: false, hooks });
const initial = { revision: 'r1', changedAt: '2026-10-15T08:00:00Z', groups, mods: [
  mod('queueLimit', 'production', ['node.maxActiveGate']), mod('autoRetry', 'production'),
  mod('surplusRetry', 'providers'), mod('surplusRouting', 'providers'), mod('streamCompat', 'rendering'),
  mod('homeQueue', 'home'), { ...mod('infrastructure', 'safety'), toggleable: false, disabledReason: 'Required infrastructure' },
] };
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(options = {}) {
  const dom = new JSDOM('<main class="vfc-main"><div id="vfc-mods"></div><section id="pc-boost-host"><div id="engine-health"></div><form data-existing-home><input aria-label="Existing Home fixture" value="preserve"></form></section><details open><div id="vfc-status"></div></details></main>', {
    url: 'https://vidforge.example/custom', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const state = { mods: clone(initial), settings: { settings: clone(defaults), defaults: clone(defaults) }, calls: [] };
  let handler = options.handler;
  dom.window.fetch = async (url, init = {}) => {
    state.calls.push({ url, ...init });
    const response = await handler?.(url, init, state);
    if (response) return { ok: response.status < 400, status: response.status, json: async () => clone(response.body) };
    let body;
    if (url === '/api/me') body = { csrfToken: 'fixture-token' };
    else if (url === '/api/vf-custom/mods') {
      if (init.method === 'PATCH') {
        const patch = JSON.parse(init.body);
        for (const m of state.mods.mods) if (Object.hasOwn(patch.changes, m.id)) {
          m.enabled = patch.changes[m.id]; m.pendingRestart = m.enabled !== m.effective;
        }
        state.mods.revision = 'r2';
      }
      body = state.mods;
    } else if (url === '/api/vf-custom/settings') {
      if (init.method === 'PATCH') Object.assign(state.settings.settings, JSON.parse(init.body));
      body = state.settings;
    } else body = { build: { report: { 'node.maxActiveGate': 'ok' } }, runtime: { queue: 'ok' }, boost: {} };
    return { ok: true, status: 200, json: async () => clone(body) };
  };
  dom.window.eval(source);
  await tick(); await tick();
  return { dom, state, page: dom.window.document.querySelector('vf-mod-settings'),
    handler: value => { handler = value; }, document: dom.window.document,
    close: () => dom.window.close() };
}
function input(f, selector, value) {
  const node = f.document.querySelector(selector);
  assert.ok(node, `Missing control ${selector}`);
  if (node.type === 'checkbox') node.checked = value; else node.value = value;
  node.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  node.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  return node;
}

test('renders all five groups and preserves the same Home editor node', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page, 'Schema-driven mod editor must mount');
    assert.deepEqual([...f.document.querySelectorAll('[data-vfc-group] > h2')].map(n => n.textContent), groupTitles);
    assert.ok(f.document.querySelector('[data-vfc-group="home"] #pc-boost-host [data-existing-home]'));
    assert.equal(f.document.querySelector('[data-existing-home] input').value, 'preserve');
    assert.equal(f.document.querySelectorAll('#engine-health').length, 1);
    assert.equal(f.document.querySelector('[data-mod-toggle="infrastructure"]').disabled, true);
    assert.equal(f.document.querySelector('[data-mod-toggle="homeMap3d"]'), null);
  } finally { f.close(); }
});

test('mod save sends only changed flags and current revision with CSRF; reports effective separately', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    input(f, '[data-mod-toggle="queueLimit"]', false);
    await f.page.saveMods();
    const patch = f.state.calls.find(c => c.url.endsWith('/mods') && c.method === 'PATCH');
    assert.deepEqual(JSON.parse(patch.body), { revision: 'r1', changes: { queueLimit: false } });
    assert.equal(patch.headers['x-csrf-token'], 'fixture-token');
    const text = f.document.querySelector('[data-mod-id="queueLimit"]').textContent;
    assert.match(text, /Gespeichert: Aus/);
    assert.match(text, /Wirksam: Ein/);
    assert.match(text, /Neustart/);
    assert.equal(f.document.querySelectorAll('[data-restart]').length, 0);
    assert.equal(f.state.calls.some(c => /restart/.test(c.url)), false);
  } finally { f.close(); }
});

test('polling preserves dirty toggle, field value, focus and untouched remote edits', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    input(f, '[data-mod-toggle="queueLimit"]', false);
    const field = input(f, '[name="maxActiveVideos"]', '19'); field.focus();
    f.state.settings.settings.autoRetryFailed = 6;
    await f.page.refresh();
    assert.equal(f.document.querySelector('[data-mod-toggle="queueLimit"]').checked, false);
    assert.equal(field.value, '19');
    assert.equal(f.document.activeElement, field);
    assert.equal(f.document.querySelector('[name="autoRetryFailed"]').value, '6');
  } finally { f.close(); }
});

test('409 reloads current state, retains draft and requires review before retry', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    input(f, '[data-mod-toggle="queueLimit"]', false);
    f.handler((url, init, state) => {
      if (url.endsWith('/mods') && init.method === 'PATCH') {
        state.mods.revision = 'external-r2';
        return { status: 409, body: { error: 'Changed elsewhere' } };
      }
    });
    await f.page.saveMods();
    assert.equal(f.document.querySelector('[data-mod-toggle="queueLimit"]').checked, false);
    assert.match(f.document.querySelector('[data-mod-message]').textContent, /geaendert|Konflikt/i);
    assert.equal(f.document.querySelector('[data-save-mods]').disabled, true);
    assert.ok(f.state.calls.filter(c => c.url.endsWith('/mods') && !c.method).length >= 2);
    assert.equal(f.state.calls.filter(c => c.method === 'PATCH').length, 1);
    f.document.querySelector('[data-review-mods]').click();
    assert.equal(f.document.querySelector('[data-save-mods]').disabled, false);
  } finally { f.close(); }
});

test('native settings save only changed fields and do not toggle feature flags', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    input(f, '[name="maxActiveVideos"]', '23');
    await f.page.saveSettings('queueLimit');
    const patches = f.state.calls.filter(c => c.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].url, '/api/vf-custom/settings');
    assert.deepEqual(JSON.parse(patches[0].body), { maxActiveVideos: 23 });
    assert.match(f.document.querySelector('[data-field="maxActiveVideos"]').textContent, /Standard: 15/);
  } finally { f.close(); }
});

test('same-field native preflight conflict prevents an overwrite and retains the draft', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    input(f, '[name="maxActiveVideos"]', '23');
    f.state.settings.settings.maxActiveVideos = 17;
    await f.page.saveSettings('queueLimit');
    assert.equal(f.state.calls.filter(c => c.method === 'PATCH').length, 0);
    assert.equal(f.document.querySelector('[name="maxActiveVideos"]').value, '23');
    assert.match(f.document.querySelector('[data-settings-message="queueLimit"]').textContent, /geaendert|Konflikt/i);
  } finally { f.close(); }
});

test('settings failures preserve draft, return an error, and never report success', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    input(f, '[name="autoRetryFailed"]', '7');
    f.handler((url, init) => init.method === 'PATCH' ? { status: 503, body: { error: 'Storage unavailable' } } : null);
    await f.page.saveSettings('autoRetry');
    assert.equal(f.document.querySelector('[name="autoRetryFailed"]').value, '7');
    assert.match(f.document.querySelector('[data-settings-message="autoRetry"]').textContent, /unavailable/);
    assert.doesNotMatch(f.document.querySelector('[data-settings-message="autoRetry"]').textContent, /^Gespeichert/);
  } finally { f.close(); }
});

test('initial settings failure does not expose writable empty/default controls', async () => {
  const f = await fixture({ handler: url => url.endsWith('/settings') ? { status: 503, body: { error: 'Settings unavailable' } } : null });
  try {
    assert.ok(f.page);
    assert.equal(f.document.querySelector('[name="maxActiveVideos"]').disabled, true);
    assert.equal(f.document.querySelector('[data-settings-save="queueLimit"]').disabled, true);
    assert.match(f.page.textContent, /Settings unavailable/);
  } finally { f.close(); }
});

test('literal registry strings and diagnostics cannot create markup; hooks are installed not active', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    f.state.mods.mods[0].title = '<img src=x onerror=alert(1)>';
    await f.page.refresh();
    assert.equal(f.document.querySelector('img'), null);
    assert.match(f.page.textContent, /<img src=x/);
    assert.match(f.document.querySelector('#vfc-status').textContent, /Installiert/);
    assert.ok(f.document.querySelector('#vfc-status th[scope="col"]'));
  } finally { f.close(); }
});

test('native range validation rejects reversed pause bounds before PATCH', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    input(f, '[name="surplusRetryMinSec"]', '60');
    input(f, '[name="surplusRetryMaxSec"]', '20');
    await f.page.saveSettings('surplusRetry');
    assert.equal(f.state.calls.filter(c => c.method === 'PATCH').length, 0);
    assert.match(f.document.querySelector('[data-settings-message="surplusRetry"]').textContent, /Minimum|Maximum/);
  } finally { f.close(); }
});

test('reverting a flag removes its dirty state and disconnect clears poller', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    input(f, '[data-mod-toggle="queueLimit"]', false);
    input(f, '[data-mod-toggle="queueLimit"]', true);
    assert.equal(f.document.querySelector('[data-save-mods]').disabled, true);
    f.page.remove();
    assert.equal(f.page.timer, null);
  } finally { f.close(); }
});

test('responsive structure has no nested cards, labels controls, and supplies narrow grid rules', async () => {
  const f = await fixture();
  try {
    assert.ok(f.page);
    assert.equal(f.page.querySelectorAll('.vc-card').length, 0);
    for (const control of f.page.querySelectorAll('input,select')) assert.ok(control.labels.length || control.getAttribute('aria-label'));
    assert.ok(f.document.querySelector('[data-mod-message][role="status"]'));
    const css = fs.readFileSync(new URL('../ui/vf-custom.css', import.meta.url), 'utf8');
    assert.match(css, /@media\s*\(max-width:\s*640px\)/);
    assert.match(css, /overflow-wrap:\s*anywhere/);
    assert.match(css, /:focus-visible/);
  } finally { f.close(); }
});

test('page shell includes all assets once and all required anchors without legacy queue form', async () => {
  const { customPage } = await import('../node/custom-page.mjs');
  const dom = new JSDOM(customPage('<link rel="stylesheet" href="/assets/native.css">'));
  try {
    const doc = dom.window.document;
    assert.ok(doc.querySelector('main#vfc-mods [data-vfc-editor]'));
    assert.ok(doc.querySelector('#pc-boost-host #engine-health'));
    assert.ok(doc.querySelector('details #vfc-status'));
    assert.equal(doc.querySelector('#vfc-queue'), null);
    assert.equal(doc.documentElement.lang, 'de');
    for (const name of ['vf-custom-page.js', 'pc-boost-settings-20261002.js', 'pc-transfer-settings-20261011.js']) {
      assert.equal(doc.querySelectorAll(`script[src*="${name}"]`).length, 1);
    }
    for (const name of ['native.css', 'vf-custom.css', 'pc-boost-settings-20261002.css', 'pc-transfer-settings-20261011.css']) {
      assert.equal(doc.querySelectorAll(`link[href*="${name}"]`).length, 1);
    }
  } finally { dom.window.close(); }
});

test('null initial revision and always-on registry entries follow the actual server contract', async () => {
  const f = await fixture();
  try {
    f.state.mods.revision = null;
    f.state.mods.mods.push({ ...mod('coreInfrastructure', 'safety'), readOnly: true, alwaysOnReason: 'Always on' });
    await f.page.refresh();
    assert.equal(f.document.querySelector('[data-mod-toggle="coreInfrastructure"]').disabled, true);
    input(f, '[data-mod-toggle="queueLimit"]', false);
    await f.page.saveMods();
    assert.equal(JSON.parse(f.state.calls.find(c => c.method === 'PATCH').body).revision, null);
  } finally { f.close(); }
});

test('malformed successful settings response cannot clear the unsaved draft', async () => {
  const f = await fixture();
  try {
    input(f, '[name="maxActiveVideos"]', '23');
    f.handler((url, init) => init.method === 'PATCH'
      ? { status: 200, body: { settings: { ...defaults, maxActiveVideos: 23 }, defaults: null } } : null);
    await f.page.saveSettings('queueLimit');
    assert.equal(f.page.fieldDraft.get('maxActiveVideos'), 23);
    assert.equal(f.document.querySelector('[name="maxActiveVideos"]').value, '23');
    assert.match(f.document.querySelector('[data-settings-message="queueLimit"]').textContent, /Ungueltig/);
  } finally { f.close(); }
});

test('a delayed pre-save poll cannot overwrite a newer mod save', async () => {
  const f = await fixture();
  try {
    let resolve;
    const oldSnapshot = clone(f.state.mods);
    f.handler((url, init) => url.endsWith('/mods') && !init.method
      ? new Promise(done => { resolve = done; }) : null);
    const polling = f.page.loadMods();
    input(f, '[data-mod-toggle="queueLimit"]', false);
    await f.page.saveMods();
    resolve({ status: 200, body: oldSnapshot });
    await polling;
    assert.equal(f.page.snapshot.revision, 'r2');
    assert.equal(f.document.querySelector('[data-mod-toggle="queueLimit"]').checked, false);
    assert.match(f.document.querySelector('[data-mod-id="queueLimit"]').textContent, /Gespeichert: Aus/);
  } finally { f.close(); }
});

test('live editors retain the same custom-element instances and dirty input when moved into Home', async () => {
  const f = await fixture();
  try {
    const pcSource = fs.readFileSync(new URL('../ui/pc-boost-settings-20261002.js', import.meta.url), 'utf8');
    const sizeSource = fs.readFileSync(new URL('../ui/pc-transfer-settings-20261011.js', import.meta.url), 'utf8');
    f.dom.window.MutationObserver = class { observe() {} disconnect() {} };
    f.dom.window.eval(pcSource); f.dom.window.eval(sizeSource);
    await tick();
    const pc = f.document.querySelector('pc-boost-settings');
    const sizes = f.document.querySelector('pc-transfer-settings');
    assert.ok(pc); assert.ok(sizes);
    pc.form.elements.namedItem('cpuWorkers').value = '21'; pc.dirty.add('cpuWorkers');
    await f.page.refresh();
    assert.equal(f.document.querySelector('pc-boost-settings'), pc);
    assert.equal(f.document.querySelector('pc-transfer-settings'), sizes);
    assert.equal(pc.form.elements.namedItem('cpuWorkers').value, '21');
    assert.ok(pc.dirty.has('cpuWorkers'));
  } finally { f.close(); }
});

test('the staged registry fits the five-group UI including its read-only infrastructure entry', async () => {
  const { GROUPS, MODS } = await import('../node/mod-registry.mjs');
  const f = await fixture();
  try {
    f.state.mods = { revision: null, groups: GROUPS, changedAt: null,
      mods: MODS.map(mod => ({ ...mod, enabled: true, effective: true, pendingRestart: false })) };
    await f.page.refresh();
    assert.equal(f.document.querySelectorAll('[data-mod-id]').length, MODS.length);
    for (const mod of MODS) assert.equal(f.document.querySelector(`[data-mod-toggle="${mod.id}"]`).disabled, mod.readOnly);
    assert.equal(f.page.modsError.textContent, '');
  } finally { f.close(); }
});
