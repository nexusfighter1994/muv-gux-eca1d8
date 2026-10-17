import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../signalforge-recovered/package.json', import.meta.url));
const Database = require('better-sqlite3');
const url = new URL('../node/mod-controls.mjs', import.meta.url);
const available = fs.existsSync(url);
const fresh = () => import(`${url.href}?test=${crypto.randomUUID()}`);
const check = (name, fn) => test(name, { skip: !available }, fn);
const route = '/api/vf-custom/mods';

function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  return db;
}

async function fixture({ db = database(), api, saved, runtimePath, loadBootSnapshot } = {}) {
  api ||= await fresh();
  if (saved !== undefined) db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('vf_mods', JSON.stringify(saved));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-mods-'));
  runtimePath ||= path.join(directory, 'active.json');
  const routes = new Map(), owner = () => {};
  const app = Object.fromEntries(['get', 'patch'].map(method => [method, (url, ...handlers) => {
    assert.ok(!routes.has(`${method} ${url}`), 'install must not duplicate routes');
    routes.set(`${method} ${url}`, handlers);
  }]));
  let control;
  try { control = api.installModControls({ app, db, requireOwner: owner, runtimePath, loadBootSnapshot }); }
  catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  const call = (method, body) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    routes.get(`${method} ${route}`).at(-1)({ body }, res);
    return res;
  };
  return { api, app, db, directory, runtimePath, control, routes, owner, call,
    close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

const row = (body, id) => body.mods.find(mod => mod.id === id);
const stored = db => JSON.parse(db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('vf_mods').value_json);

test('controls export installer and boot-snapshot reader', async () => {
  const api = available ? await fresh() : {};
  assert.equal(typeof api.installModControls, 'function');
  assert.equal(typeof api.modEnabled, 'function');
});

check('import has no runtime writes, network calls or installation side effects', async () => {
  const write = fs.writeFileSync, mkdir = fs.mkdirSync, fetch = globalThis.fetch;
  let effects = 0;
  try {
    fs.writeFileSync = fs.mkdirSync = globalThis.fetch = () => { effects++; throw Error('Unexpected import effect'); };
    const api = await fresh();
    assert.equal(effects, 0);
    assert.throws(() => api.modEnabled('queueLimit'), /installModControls.*before|not installed/i);
    assert.throws(() => api.modEnabled('typo'), /unknown.*typo/i);
  } finally { fs.writeFileSync = write; fs.mkdirSync = mkdir; globalThis.fetch = fetch; }
});

check('first install publishes immutable true defaults without touching other settings', async () => {
  const f = await fixture();
  try {
    const state = f.call('get').body;
    assert.equal(state.revision, null);
    assert.equal(state.changedAt, null);
    assert.equal(state.mods.length, 31);
    assert.equal(row(state, 'thumbnailIdentity').defaultEnabled, true);
    assert.equal(row(state, 'homeMap').defaultEnabled, true);
    assert.equal(row(state, 'homeMotion').defaultEnabled, true);
    assert.ok(state.mods.every(mod => mod.enabled && mod.effective && !mod.pendingRestart));
    assert.ok(state.mods.filter(mod => !mod.readOnly).every(mod => mod.restartRequired));
    assert.equal(row(state, 'coreInfrastructure').restartRequired, false);
    assert.equal(f.api.modEnabled('queueLimit'), true);
    assert.equal(f.api.modEnabled('coreInfrastructure'), true);
    assert.throws(() => f.api.modEnabled('__proto__'), /unknown/i);
    const projection = JSON.parse(fs.readFileSync(f.runtimePath, 'utf8'));
    assert.deepEqual(Object.keys(projection).sort(), ['changedAt', 'mods', 'revision', 'version']);
    assert.equal(projection.version, 1);
    assert.equal(Object.keys(projection.mods).length, 30);
    assert.ok(Object.values(projection.mods).every(value => value === true));
    assert.equal(f.db.prepare('SELECT count(*) n FROM app_settings').get().n, 0);
    assert.equal(f.routes.get(`get ${route}`)[0], f.owner);
    assert.equal(f.routes.get(`patch ${route}`)[0], f.owner);
  } finally { f.close(); }
});

check('PATCH changes desired only, persists UUID revision and leaves active bytes unchanged', async () => {
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('vf_custom', '{"maxActiveVideos":13}');
    const bytes = fs.readFileSync(f.runtimePath, 'utf8');
    const result = f.call('patch', { revision: null, changes: { queueLimit: false, homeSiglip: false } });
    assert.equal(result.statusCode, 200);
    assert.match(result.body.revision, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(result.body.changedAt)));
    assert.equal(row(result.body, 'queueLimit').enabled, false);
    assert.equal(row(result.body, 'queueLimit').effective, true);
    assert.equal(row(result.body, 'queueLimit').pendingRestart, true);
    assert.equal(f.api.modEnabled('queueLimit'), true);
    assert.equal(fs.readFileSync(f.runtimePath, 'utf8'), bytes);
    assert.equal(stored(f.db).mods.queueLimit, false);
    assert.equal(f.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('vf_custom').value_json,
      '{"maxActiveVideos":13}');
    assert.deepEqual(f.call('get').body, result.body);
  } finally { f.close(); }
});

check('same-value save is a no-op; reversing desired to effective clears pending restart', async () => {
  const f = await fixture();
  try {
    assert.equal(f.call('patch', { revision: null, changes: { queueLimit: true } }).body.revision, null);
    const first = f.call('patch', { revision: null, changes: { queueLimit: false } }).body;
    const unchanged = f.call('patch', { revision: first.revision, changes: { queueLimit: false } }).body;
    assert.equal(unchanged.revision, first.revision);
    assert.equal(unchanged.changedAt, first.changedAt);
    const reversed = f.call('patch', { revision: first.revision, changes: { queueLimit: true } }).body;
    assert.equal(row(reversed, 'queueLimit').pendingRestart, false);
    assert.notEqual(reversed.revision, first.revision);
  } finally { f.close(); }
});

check('stale writers receive 409 and cannot clobber a newer DB revision', async () => {
  const f = await fixture();
  try {
    const first = f.call('patch', { revision: null, changes: { restage: false } }).body;
    const rejected = f.call('patch', { revision: null, changes: { sheetBatch: false } });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.body.code, 'revision_conflict');
    assert.equal(rejected.body.revision, first.revision);
    const external = { ...stored(f.db), revision: crypto.randomUUID(), mods: { ...stored(f.db).mods, engineRetry: false } };
    f.db.prepare('UPDATE app_settings SET value_json = ? WHERE key = ?').run(JSON.stringify(external), 'vf_mods');
    assert.equal(f.call('get').body.revision, external.revision);
    assert.equal(f.call('patch', { revision: first.revision, changes: { sheetBatch: false } }).statusCode, 409);
    assert.deepEqual(stored(f.db), external);
  } finally { f.close(); }
});

check('PATCH strictly rejects malformed, unknown, read-only, and non-boolean fields', async () => {
  const f = await fixture();
  try {
    const invalid = [null, [], {}, { revision: null }, { changes: { queueLimit: false } },
      { revision: null, changes: {} }, { revision: null, changes: [] },
      { revision: 1, changes: { queueLimit: false } }, { revision: 'bad', changes: { queueLimit: false } },
      { revision: null, changes: { unknown: false } }, { revision: null, changes: { coreInfrastructure: true } },
      { revision: null, changes: { queueLimit: 0 } }, { revision: null, changes: { queueLimit: 'false' } },
      { revision: null, changes: { queueLimit: null } }, { revision: null, changes: { queueLimit: false }, effective: false },
      { revision: null, changes: JSON.parse('{"__proto__":false}') },
      { revision: null, changes: { queueLimit: false, unknown: true } },
    ];
    const bytes = fs.readFileSync(f.runtimePath, 'utf8');
    for (const input of invalid) assert.equal(f.call('patch', input).statusCode, 400, JSON.stringify(input));
    assert.equal(f.db.prepare('SELECT count(*) n FROM app_settings').get().n, 0);
    assert.equal(fs.readFileSync(f.runtimePath, 'utf8'), bytes);
  } finally { f.close(); }
});

check('all-false saved policy loads at install and is mirrored without activating new features', async () => {
  const { MODS } = await import(new URL('../node/mod-registry.mjs', import.meta.url));
  const mods = Object.fromEntries(MODS.filter(mod => !mod.readOnly).map(mod => [mod.id, false]));
  const saved = { version: 1, revision: crypto.randomUUID(), changedAt: new Date().toISOString(), mods };
  const f = await fixture({ saved });
  try {
    for (const id of Object.keys(mods)) assert.equal(f.api.modEnabled(id), false, id);
    assert.ok(f.call('get').body.mods.filter(mod => !mod.readOnly).every(mod => !mod.enabled && !mod.effective && !mod.pendingRestart));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.runtimePath, 'utf8')), saved);
    const next = f.call('patch', { revision: saved.revision, changes: { queueLimit: true } }).body;
    assert.equal(row(next, 'queueLimit').effective, false);
    assert.equal(row(next, 'queueLimit').pendingRestart, true);
  } finally { f.close(); }
});

check('reinstall on same app neither reloads pending desired flags nor duplicates routes', async () => {
  const f = await fixture();
  try {
    f.call('patch', { revision: null, changes: { queueLimit: false } });
    const bytes = fs.readFileSync(f.runtimePath, 'utf8');
    const again = f.api.installModControls({ app: f.app, db: f.db, requireOwner: f.owner, runtimePath: f.runtimePath });
    assert.equal(again, f.control);
    assert.equal(f.api.modEnabled('queueLimit'), true);
    assert.equal(fs.readFileSync(f.runtimePath, 'utf8'), bytes);
    assert.equal(f.routes.size, 2);
    assert.throws(() => f.api.installModControls({ app: { get() {}, patch() {} }, db: f.db, requireOwner: f.owner, runtimePath: f.runtimePath }), /already installed|another app/i);
  } finally { f.close(); }
});

check('new process/module installation adopts desired policy while old snapshot remains unchanged', async () => {
  const f = await fixture();
  let second;
  try {
    const saved = f.call('patch', { revision: null, changes: { queueLimit: false } }).body;
    const db = database();
    second = await fixture({ db, saved: stored(f.db) });
    assert.equal(f.api.modEnabled('queueLimit'), true);
    assert.equal(second.api.modEnabled('queueLimit'), false);
    assert.equal(second.call('get').body.revision, saved.revision);
    assert.equal(row(second.call('get').body, 'queueLimit').pendingRestart, false);
  } finally { second?.close(); f.close(); }
});

check('database failure leaves desired and active policy unchanged and returns no success', async () => {
  const f = await fixture();
  try {
    const before = f.call('patch', { revision: null, changes: { queueLimit: false } }).body;
    const bytes = fs.readFileSync(f.runtimePath, 'utf8');
    f.db.exec("CREATE TRIGGER reject_mods BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const failed = f.call('patch', { revision: before.revision, changes: { restage: false } });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.body.code, 'mods_unavailable');
    assert.deepEqual(f.call('get').body, before);
    assert.equal(fs.readFileSync(f.runtimePath, 'utf8'), bytes);
  } finally { f.close(); }
});

check('corrupt saved policies fail closed without overwriting existing active projection', async () => {
  const valid = { version: 1, revision: crypto.randomUUID(), changedAt: new Date().toISOString(), mods: { queueLimit: false } };
  for (const value of ['{broken', JSON.stringify({ ...valid, mods: { invented: false } }),
    JSON.stringify({ ...valid, mods: { queueLimit: 'false' } }), JSON.stringify({ ...valid, version: 2 })]) {
    const db = database(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-mods-corrupt-'));
    const runtimePath = path.join(directory, 'active.json');
    try {
      db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('vf_mods', value);
      fs.writeFileSync(runtimePath, 'existing active projection');
      const api = await fresh();
      assert.throws(() => api.installModControls({ app: { get() {}, patch() {} }, db, requireOwner() {}, runtimePath }));
      assert.equal(fs.readFileSync(runtimePath, 'utf8'), 'existing active projection');
      assert.equal(db.prepare('SELECT value_json FROM app_settings').get().value_json, value);
      assert.throws(() => api.modEnabled('queueLimit'), /installModControls.*before|not installed/i);
    } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

check('projection failure cannot install a misleading boot snapshot or API', async () => {
  const api = await fresh(), db = database(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-mods-write-'));
  let routes = 0;
  try {
    assert.throws(() => api.installModControls({ app: { get() { routes++; }, patch() { routes++; } },
      db, requireOwner() {}, runtimePath: directory }));
    assert.equal(routes, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM app_settings').get().n, 0);
    assert.throws(() => api.modEnabled('queueLimit'), /installModControls.*before|not installed/i);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

check('Node adopts an earlier Python generation snapshot instead of activating later desired changes', async () => {
  const desired = { version: 1, revision: crypto.randomUUID(), changedAt: new Date().toISOString(), mods: { queueLimit: true } };
  const active = { ...desired, generation: 'container-start', mods: { queueLimit: false } };
  const f = await fixture({ saved: desired, loadBootSnapshot(file) {
    fs.writeFileSync(file, JSON.stringify(active));
    return active;
  } });
  try {
    assert.equal(f.api.modEnabled('queueLimit'), false);
    const state = row(f.call('get').body, 'queueLimit');
    assert.equal(state.enabled, true);
    assert.equal(state.effective, false);
    assert.equal(state.pendingRestart, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.runtimePath, 'utf8')), active);
  } finally { f.close(); }
});
