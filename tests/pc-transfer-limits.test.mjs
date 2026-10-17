import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const Database = require('better-sqlite3');
const url = new URL('../node/pc-transfer-api.mjs', import.meta.url);
const api = fs.existsSync(url) ? await import(url.href) : {};
const defaults = { ffmpegMaxFileMb: 64, ffmpegMaxTotalMb: 96, sceneMaxFileMb: 400, siglipMaxImageMb: 20 };
function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  return db;
}
function fixture(options = {}) {
  const db = database();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-transfers-'));
  const routes = new Map();
  const owner = () => {};
  const app = Object.fromEntries(['get', 'patch'].map(method => [method,
    (url, ...handlers) => routes.set(`${method} ${url}`, handlers)]));
  const control = api.installTransferControls({ app, db, requireOwner: owner, runtimePath: path.join(directory, 'limits.json'),
    workerClient: { read: async () => ({ ffmpeg: { ok: false, reason: 'offline' }, siglip: { ok: false, reason: 'offline' } }) },
    logger: { error() {} }, startTimer: false, ...options });
  const call = async (method, url, body) => {
    const req = { body }, res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
    for (const handler of routes.get(`${method} ${url}`)) if (handler !== owner) await handler(req, res);
    return res;
  };
  return { db, app, routes, owner, control, call, directory, close() { control.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('separate transfer module is available without replacing PC Boost', () => {
  assert.equal(typeof api.installTransferControls, 'function');
});
test('defaults use the exact existing MiB limits and strict numeric bounded values', () => {
  assert.deepEqual(api.DEFAULT_TRANSFER_LIMITS, defaults);
  assert.deepEqual(api.validateTransferLimits({ ffmpegMaxFileMb: 4096, siglipMaxImageMb: 128 }, defaults),
    { ...defaults, ffmpegMaxFileMb: 4096, siglipMaxImageMb: 128 });
  for (const [key, ceiling] of Object.entries({ ffmpegMaxFileMb: 4096, ffmpegMaxTotalMb: 4096, sceneMaxFileMb: 4096, siglipMaxImageMb: 128 })) {
    for (const value of [0, -1, ceiling + 1, '64', true, 1.5, NaN, Infinity]) {
      assert.throws(() => api.validateTransferLimits({ [key]: value }, defaults), error => error.status === 400);
    }
  }
  for (const value of [null, [], {}, { token: 'never' }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => api.validateTransferLimits(value), error => error.status === 400);
  }
});
test('reading defaults never writes SQLite, existing worker selections, or a runtime file', () => {
  const db = database(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-transfer-default-'));
  const runtimePath = path.join(directory, 'limits.json');
  try {
    db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('pc_boost', '{"enabled":true,"siglipConcurrency":12}');
    const store = api.createTransferStore({ db, runtimePath });
    assert.deepEqual(store.get(), { limits: defaults, revision: null, configured: false });
    assert.equal(fs.existsSync(runtimePath), false);
    assert.equal(db.prepare('SELECT count(*) n FROM app_settings').get().n, 1);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('save persists an independent record and atomic runtime mirror; restart replays same revision', () => {
  const f = fixture();
  try {
    const saved = f.control.store.update({ sceneMaxFileMb: 512 });
    assert.deepEqual(saved.limits, { ...defaults, sceneMaxFileMb: 512 });
    assert.match(saved.revision, /^[0-9a-f-]{36}$/);
    assert.equal(saved.configured, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'limits.json'), 'utf8')), { ...saved.limits, revision: saved.revision });
    assert.deepEqual(api.createTransferStore({ db: f.db, runtimePath: path.join(f.directory, 'limits.json') }).get(), saved);
    assert.deepEqual(f.db.prepare('SELECT key FROM app_settings').all(), [{ key: 'pc_boost_transfer_limits' }]);
  } finally { f.close(); }
});
test('failed database write leaves old runtime bytes and selections intact', () => {
  const f = fixture();
  try {
    const saved = f.control.store.update({ sceneMaxFileMb: 512 });
    const original = fs.readFileSync(path.join(f.directory, 'limits.json'), 'utf8');
    f.db.exec("CREATE TRIGGER reject_transfer BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.throws(() => f.control.store.update({ sceneMaxFileMb: 600 }));
    assert.deepEqual(f.control.store.get(), saved);
    assert.equal(fs.readFileSync(path.join(f.directory, 'limits.json'), 'utf8'), original);
  } finally { f.close(); }
});
test('atomic mirror failure rolls back SQLite and reports no successful save', () => {
  const db = database();
  try {
    const store = api.createTransferStore({ db, runtimePath: '/not-used', writeRuntime() { throw new Error('fixture I/O failure'); } });
    assert.throws(() => store.update({ sceneMaxFileMb: 512 }));
    assert.deepEqual(store.get(), { limits: defaults, revision: null, configured: false });
    assert.equal(db.prepare('SELECT count(*) n FROM app_settings').get().n, 0);
  } finally { db.close(); }
});
test('corrupt stored limits are never silently replaced or published', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('pc_boost_transfer_limits', '{broken');
    assert.throws(() => api.createTransferStore({ db, runtimePath: '/not-used' }));
    assert.equal(db.prepare('SELECT value_json FROM app_settings').get().value_json, '{broken');
  } finally { db.close(); }
});
test('fresh runtime reads expose current values and reject corrupted files without defaults substitution', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-transfer-readback-'));
  const runtimePath = path.join(directory, 'limits.json');
  try {
    assert.deepEqual(api.readTransferRuntime(runtimePath), { limits: defaults, revision: null, configured: false });
    api.writeTransferRuntime(runtimePath, { limits: { ...defaults, siglipMaxImageMb: 32 }, revision: '12345678-1234-1234-1234-123456789abc' });
    assert.equal(api.readTransferRuntime(runtimePath).limits.siglipMaxImageMb, 32);
    fs.writeFileSync(runtimePath, '{broken');
    assert.throws(() => api.readTransferRuntime(runtimePath));
    assert.equal(fs.readFileSync(runtimePath, 'utf8'), '{broken');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('owner middleware protects both endpoints; invalid keys return 400', async () => {
  const f = fixture();
  try {
    for (const method of ['get', 'patch']) assert.equal(f.routes.get(`${method} /api/pc-boost/transfer-limits`)[0], f.owner);
    assert.equal((await f.call('patch', '/api/pc-boost/transfer-limits', { maxActiveVideos: 25 })).statusCode, 400);
    assert.equal((await f.call('get', '/api/pc-boost/transfer-limits')).body.units, 'MiB');
  } finally { f.close(); }
});
test('save and PUT are pending until exact GET readback from both workers', async () => {
  let actual = { ...defaults }, reads = 0, syncs = 0;
  const f = fixture({ workerClient: {
    async read() { reads++; return Object.fromEntries(['ffmpeg', 'siglip'].map(kind => [kind, { ok: true, limits: { ...actual } }])); },
    async syncTransfer(limits) { syncs++; actual = { ...limits }; return {}; },
  } });
  try {
    await f.control.reconcile();
    assert.equal(syncs, 0, 'default values never pushed to workers');
    const saved = await f.call('patch', '/api/pc-boost/transfer-limits', { siglipMaxImageMb: 32 });
    assert.equal(saved.body.status, 'pending');
    await f.control.reconcile();
    const state = f.control.snapshot();
    assert.equal(state.status, 'active');
    assert.equal(state.workers.siglip.observed.siglipMaxImageMb, 32);
    assert.ok(reads >= 2);
    assert.equal(syncs, 1);
  } finally { f.close(); }
});
test('mismatched, offline, or malformed worker readback cannot be called active', async () => {
  const f = fixture({ workerClient: {
    async read() { return { ffmpeg: { ok: true, limits: defaults }, siglip: { ok: true, limits: { ...defaults, token: 'never' } } }; },
    async syncTransfer() { return { ok: true }; },
  } });
  try {
    f.control.store.update({ siglipMaxImageMb: 32 });
    await f.control.reconcile();
    const state = f.control.snapshot();
    assert.notEqual(state.status, 'active');
    assert.equal(state.workers.siglip.observed, null);
    assert.ok(!JSON.stringify(state).includes('never'));
  } finally { f.close(); }
});
test('private client uses allowlisted endpoints, no redirects, bounded JSON, and full limits only', async () => {
  const calls = [];
  const client = api.createTransferWorkerClient({ readToken: () => 'fixture-private', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ limits: defaults }), { status: 200 });
  } });
  await client.read();
  await client.syncTransfer(defaults);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => /http:\/\/10\.0\.3\.1:1819[14]\/transfer-limits$/.test(call.url)));
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  assert.ok(calls.filter(call => call.options.method === 'PUT').every(call => JSON.stringify(JSON.parse(call.options.body)) === JSON.stringify(defaults)));
  assert.throws(() => api.createTransferWorkerClient({ ffmpegUrl: 'https://outside.example:18191' }));
  const oversized = api.createTransferWorkerClient({ readToken: () => 'fixture-private', fetchImpl: async () => new Response('x'.repeat(17000)) });
  assert.equal((await oversized.read()).ffmpeg.ok, false);
});

test('late hot-install precedes terminal 404 but never bypasses native sessions or CSRF', async () => {
  const expressRequire = createRequire('C:/Users/user/Documents/Codex/2026-10-07/sag/work/vidiq-api/package.json');
  const express = expressRequire('express');
  const app = express(), db = database(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-transfer-router-'));
  app.use(express.json());
  app.use('/api', (req, res, next) => req.headers['x-owner'] === '1' ? next() : res.sendStatus(401));
  app.use('/api', (req, res, next) => req.method === 'GET' || req.headers['x-csrf'] === '1' ? next() : res.sendStatus(403));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  const requireOwner = (req, res, next) => req.headers['x-owner'] === '1' ? next() : res.sendStatus(403);
  const args = { app, db, requireOwner, runtimePath: path.join(directory, 'limits.json'), startTimer: false };
  const installed = api.installTransferControls(args);
  const stack = app._router?.stack || app.router.stack;
  const count = stack.length;
  assert.equal(api.installTransferControls(args), installed);
  assert.equal(stack.length, count);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/pc-boost/transfer-limits`;
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { 'x-owner': '1' } })).status, 200);
    assert.equal((await fetch(base, { method: 'PATCH', headers: { 'x-owner': '1', 'content-type': 'application/json' }, body: '{"sceneMaxFileMb":512}' })).status, 403);
    assert.equal((await fetch(base, { method: 'PATCH', headers: { 'x-owner': '1', 'x-csrf': '1', 'content-type': 'application/json' }, body: '{"sceneMaxFileMb":512}' })).status, 200);
  } finally { installed.close(); await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('normal installation declares sender readiness without changing limits or seeding settings', () => {
  const f = fixture();
  try {
    const state = f.control.snapshot();
    assert.deepEqual(state.senderActivation, { ffmpeg: true, scenes: true, siglip: true });
    assert.equal(state.status, 'defaults');
    assert.deepEqual(state.limits, defaults);
    assert.equal(f.db.prepare('SELECT count(*) n FROM app_settings').get().n, 0);
  } finally { f.close(); }
});

test('cached sender marks stay pending even when receiving workers report exact desired limits', async () => {
  const f = fixture({ senderReady: false, workerClient: {
    read: async () => Object.fromEntries(['ffmpeg', 'siglip'].map(kind => [kind, { ok: true, limits: defaults }])),
    syncTransfer: async () => {},
  } });
  try {
    assert.deepEqual(f.control.snapshot().senderActivation, { ffmpeg: false, scenes: false, siglip: true });
    assert.equal(f.control.snapshot().status, 'defaults');
    f.control.store.update({ sceneMaxFileMb: 400 });
    await f.control.reconcile();
    const state = f.control.snapshot();
    assert.equal(state.receiverStatus, 'active');
    assert.equal(state.status, 'server_reload_pending');
    const response = await f.call('get', '/api/pc-boost/transfer-limits');
    assert.equal(response.body.status, 'server_reload_pending');
    assert.deepEqual(response.body.limits, defaults);
    const saved = await f.call('patch', '/api/pc-boost/transfer-limits', { siglipMaxImageMb: 32 });
    assert.equal(saved.body.status, 'server_reload_pending');
    assert.equal(saved.body.limits.siglipMaxImageMb, 32);
    f.control.markSenderReady(true);
    assert.deepEqual(f.control.snapshot().senderActivation, { ffmpeg: true, scenes: true, siglip: true });
    assert.equal(f.control.snapshot().status, 'pending', 'receiver mismatch is not promoted to active');
  } finally { f.close(); }
});

test('fresh-module metadata retrofit overlays already installed owner GET/PATCH without reinstall or state mutation', async () => {
  const expressRequire = createRequire('C:/Users/user/Documents/Codex/2026-10-07/sag/work/vidiq-api/package.json');
  const express = expressRequire('express');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => req.headers['x-owner'] === '1' ? next() : res.sendStatus(401));
  app.use('/api', (req, res, next) => req.method === 'GET' || req.headers['x-csrf'] === '1' ? next() : res.sendStatus(403));
  let state = { limits: { ...defaults }, configured: true, revision: 'fixture-existing-revision', status: 'active',
    workers: Object.fromEntries(['ffmpeg', 'siglip'].map(kind => [kind, { observed: { ...defaults } }])) };
  let saves = 0;
  const old = { snapshot: () => ({ ...state, limits: { ...state.limits } }), store: { untouched: true }, close() {} };
  app[Symbol.for('vf.pcBoost.transferLimits')] = old;
  const owner = (req, res, next) => req.headers['x-owner'] === '1' ? next() : res.sendStatus(403);
  app.get('/api/pc-boost/transfer-limits', owner, (_req, res) => res.json({ ...state }));
  app.patch('/api/pc-boost/transfer-limits', owner, (req, res) => {
    if (req.body.bad) return res.status(400).json({ error: 'original validation error' });
    state = { ...state, limits: { ...state.limits, ...req.body } };
    saves++;
    return res.json({ ...state, status: 'pending' });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  const stack = app._router?.stack || app.router.stack;
  const routeCount = stack.length;
  const response = api.markSenderReady(app, false);
  assert.equal(response.status, 'server_reload_pending');
  assert.deepEqual(response.senderActivation, { ffmpeg: false, scenes: false, siglip: true });
  assert.equal(saves, 0);
  assert.equal(api.installTransferControls({ app }), old);
  assert.equal(stack.length, routeCount);
  assert.equal(old.store.untouched, true);
  assert.equal(old.snapshot().senderActivation.ffmpeg, false, 'idempotent install must not reset false to normal default true');
  api.markSenderReady(app, false);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/pc-boost/transfer-limits`;
  try {
    assert.equal((await fetch(base)).status, 401);
    const get = await fetch(base, { headers: { 'x-owner': '1' } });
    const data = await get.json();
    assert.equal(data.status, 'server_reload_pending');
    assert.equal(data.receiverStatus, 'active');
    assert.deepEqual(data.limits, defaults);
    assert.equal((await fetch(base, { method: 'PATCH', headers: { 'x-owner': '1', 'content-type': 'application/json' }, body: '{"sceneMaxFileMb":512}' })).status, 403);
    const patch = await fetch(base, { method: 'PATCH', headers: { 'x-owner': '1', 'x-csrf': '1', 'content-type': 'application/json' }, body: '{"sceneMaxFileMb":512}' });
    const saved = await patch.json();
    assert.equal(saved.status, 'server_reload_pending');
    assert.equal(saved.limits.sceneMaxFileMb, 512);
    assert.equal(saved.receiverStatus, 'pending');
    assert.equal(saves, 1, 'old original save handler executes exactly once');
    const invalid = await fetch(base, { method: 'PATCH', headers: { 'x-owner': '1', 'x-csrf': '1', 'content-type': 'application/json' }, body: '{"bad":true}' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'original validation error' });
    old.markSenderReady(true);
    assert.equal((await (await fetch(base, { headers: { 'x-owner': '1' } })).json()).status, 'active');
    assert.equal(stack.length, routeCount);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('readiness validates per-lane booleans and never accepts values as transfer settings', () => {
  const f = fixture();
  try {
    assert.equal(typeof f.control.markSenderReady, 'function');
    assert.deepEqual(f.control.markSenderReady({ ffmpeg: true, scenes: false, siglip: true }).senderActivation,
      { ffmpeg: true, scenes: false, siglip: true });
    for (const value of [null, [], 0, 'false', { ffmpeg: false }, { ffmpeg: false, scenes: false, siglip: 1 },
      { ffmpeg: true, scenes: true, siglip: true, token: 'never' }]) assert.throws(() => f.control.markSenderReady(value));
    assert.deepEqual(f.control.snapshot().senderActivation, { ffmpeg: true, scenes: false, siglip: true });
    assert.deepEqual(f.control.store.get().limits, defaults);
  } finally { f.close(); }
});
