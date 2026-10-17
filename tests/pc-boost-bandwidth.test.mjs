import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../node/pc-boost-api.mjs';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const Database = require('better-sqlite3');
const available = typeof api.installBandwidthControls === 'function';
const rates = { downMbit: 120, upMbit: 37 };
const workerKeys = ['cpuWorkers', 'gpuWorkers', 'siglipConcurrency', 'sceneWorkers'];
for (const key of workerKeys) {
  test(`${key} accepts 25, rejects 26, and retains the selected value for a missing field`, () => {
    assert.equal(api.CONFIG_BOUNDS[key].max, 25);
    assert.equal(api.validateConfig({ [key]: 25 })[key], 25);
    assert.throws(() => api.validateConfig({ [key]: 26 }), error => error.status === 400);
    assert.equal(api.validateConfig({}, { ...api.DEFAULT_CONFIG, [key]: 3 })[key], 3);
  });
}
test('worker defaults and independent video concurrency are unchanged', () => {
  assert.deepEqual(api.DEFAULT_CONFIG, { enabled: false, cpuWorkers: 5, gpuWorkers: 4,
    siglipEnabled: true, siglipConcurrency: 1, sceneWorkers: 5, clipvaultBoost: 40, ffmpegBoost: 0, motionSlots: 2, motionHomeShare: 70 });
  assert.throws(() => api.validateConfig({ maxActiveVideos: 13 }));
});
test('CPU-only VF extra capacity and activity ignore shared PC GPU FFmpeg slots', () => {
  assert.equal(typeof api.pcFfmpegCapacity, 'function');
  assert.equal(typeof api.pcFfmpegActive, 'function');
  assert.equal(api.pcFfmpegCapacity({ cpuCapacity: 5, gpuAvailable: true, gpuCapacity: 25 }), 5);
  assert.equal(api.pcFfmpegActive({ cpuCapacity: 5, cpuActive: 2, gpuActive: 25 }), 2);
  assert.equal(api.pcFfmpegCapacity({ cpuCapacity: 25, gpuAvailable: true, gpuCapacity: 25 }), 25);
});
test('the real capacity probe publishes CPU-only extra slots without disabling SigLIP or scene capacity', async () => {
  const db = database();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-cpu-extra-'));
  db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('pc_boost', JSON.stringify({ ...api.DEFAULT_CONFIG,
    enabled: true, cpuWorkers: 5, gpuWorkers: 25, siglipConcurrency: 3, sceneWorkers: 25 }));
  const intervals = [];
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  const previousFlag = process.env.VF_PC_BOOST_SCHEDULER_EXTRA;
  const keys = ['__vfPcBoostFfmpegExtra', '__vfPcBoostActive', '__vfPcSceneSlots', '__vfPcFfmpegLimit', '__vfPcClipvaultLimit'];
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let installed;
  try {
    for (const key of keys) delete globalThis[key];
    process.env.VF_PC_BOOST_SCHEDULER_EXTRA = '1';
    globalThis.setInterval = (callback, delay) => { intervals.push({ callback, delay }); return { unref() {} }; };
    globalThis.clearInterval = () => {};
    const app = { get() {}, patch() {}, post() {} };
    let synced;
    installed = api.installPcBoost({ app, db, requireOwner() {}, runtimePath: path.join(directory, 'pc-boost.json'),
      logger: { info() {}, error() {}, warn() {} }, workerClient: {
        async sync(config) { synced = config; },
        async health() { return { ffmpeg: { reachable: true, ready: true, cpuCapacity: 5, cpuActive: 2,
          gpuAvailable: true, gpuCapacity: 25, gpuActive: 25, sceneReady: true, sceneCapacity: 25 } }; },
      } });
    await new Promise(resolve => setImmediate(resolve));
    intervals.find(timer => timer.delay === 3000).callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(globalThis.__vfPcBoostFfmpegExtra, 5);
    assert.equal(globalThis.__vfPcBoostActive, 2);
    assert.equal(globalThis.__vfPcSceneSlots, 25);
    assert.equal(synced.siglipEnabled, true);
    assert.equal(synced.siglipConcurrency, 3);
    assert.equal(synced.gpuWorkers, 25);
  } finally {
    installed?.close();
    globalThis.setInterval = set; globalThis.clearInterval = clear;
    if (previousFlag === undefined) delete process.env.VF_PC_BOOST_SCHEDULER_EXTRA;
    else process.env.VF_PC_BOOST_SCHEDULER_EXTRA = previousFlag;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
    db.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  return db;
}
function fixture(options = {}) {
  const db = database();
  const routes = new Map();
  const owner = () => {};
  const app = Object.fromEntries(['get', 'patch', 'post'].map(method => [method,
    (url, ...handlers) => routes.set(`${method} ${url}`, handlers)]));
  const control = api.installBandwidthControls({ app, db, requireOwner: owner,
    readToken: () => 'fixture-token-not-a-secret', ...options });
  const call = async (method, url, body, token = 'fixture-token-not-a-secret') => {
    const handlers = routes.get(`${method} ${url}`);
    assert.ok(handlers, `${method} ${url} exists`);
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    const req = { body, headers: { authorization: `Bearer ${token}` } };
    for (const handler of handlers) {
      if (handler === owner) continue;
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next) break;
    }
    return res;
  };
  return { db, routes, owner, control, call };
}

test('bandwidth controls are available without replacing the PC Boost installer', () => {
  assert.equal(typeof api.installBandwidthControls, 'function');
});
test('strict directional total caps use the actual limiter range, never fake uncapped', { skip: !available }, () => {
  assert.deepEqual(api.validateBandwidth(rates), rates);
  assert.deepEqual(api.validateBandwidth({ upMbit: 80 }, rates), { downMbit: 120, upMbit: 80 });
  assert.deepEqual(api.validateBandwidth({ downMbit: 1000, upMbit: 1 }), { downMbit: 1000, upMbit: 1 });
  for (const patch of [null, [], '', {}, { downMbit: 80 }, { downMbit: 0, upMbit: 37 },
    { downMbit: -1, upMbit: 37 }, { downMbit: 1001, upMbit: 37 }, { downMbit: 1.5, upMbit: 37 },
    { downMbit: '120', upMbit: 37 }, { downMbit: true, upMbit: 37 },
    { downMbit: NaN, upMbit: 37 }, { downMbit: Infinity, upMbit: 37 },
    { ...rates, token: 'do-not-accept' }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => api.validateBandwidth(patch), error => error.status === 400);
  }
  // Full-duplex limits are independent totals, not a fabricated down+up sum.
  assert.equal(api.validateBandwidth({ downMbit: 1000, upMbit: 1000 }).upMbit, 1000);
  assert.equal(api.PC_CONFIG_KEYS.includes('downMbit'), false);
  assert.equal(api.PC_CONFIG_KEYS.includes('upMbit'), false);
});
test('initialization never seeds or resets either existing settings or the live local file', { skip: !available }, () => {
  const db = database();
  const original = '{"enabled":true,"cpuWorkers":8}';
  db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('pc_boost', original);
  try {
    const store = api.createBandwidthStore({ db });
    assert.equal(store.get().desired, null);
    assert.deepEqual(db.prepare('SELECT * FROM app_settings').all(), [{ key: 'pc_boost', value_json: original }]);
  } finally { db.close(); }
});
test('desired caps persist separately across deployment; failed SQLite writes retain previous state', { skip: !available }, () => {
  const db = database();
  try {
    const store = api.createBandwidthStore({ db });
    const first = store.update(rates);
    assert.deepEqual(first.desired, rates);
    assert.match(first.revision, /^[0-9a-f-]{36}$/);
    assert.deepEqual(api.createBandwidthStore({ db }).get(), first);
    db.exec("CREATE TRIGGER reject_bandwidth BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => store.update({ upMbit: 50 }));
    assert.deepEqual(store.get(), first);
  } finally { db.close(); }
});
test('invalid stored bandwidth is left byte-identical and reported unavailable', { skip: !available }, () => {
  const db = database();
  try {
    db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('pc_boost_bandwidth', '{broken');
    assert.throws(() => api.createBandwidthStore({ db }));
    assert.equal(db.prepare('SELECT value_json FROM app_settings WHERE key=?').get('pc_boost_bandwidth').value_json, '{broken');
  } finally { db.close(); }
});
test('owner and CSRF middleware guard public bandwidth edits; internal routes require a private token', { skip: !available }, async () => {
  const f = fixture();
  try {
    assert.equal(f.routes.get('get /api/pc-boost/bandwidth')[0], f.owner);
    assert.equal(f.routes.get('patch /api/pc-boost/bandwidth')[0], f.owner);
    for (const token of ['', 'wrong', 'x'.repeat(5000)]) {
      const result = await f.call('get', '/api/pc-boost/bandwidth/bridge', undefined, token);
      assert.equal(result.statusCode, 401);
      assert.ok(!JSON.stringify(result.body).includes('fixture-token'));
    }
    assert.equal((await f.call('patch', '/api/pc-boost/bandwidth', { ...rates, upMbit: 0 })).statusCode, 400);
    assert.equal(f.control.store.get().desired, null);
  } finally { f.db.close(); }
});
test('cap saves stay pending until a matching kernel-shaper readback, not a measured throughput claim', { skip: !available }, async () => {
  let now = 100000;
  const f = fixture({ now: () => now });
  try {
    const saved = await f.call('patch', '/api/pc-boost/bandwidth', rates);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.status, 'pending');
    assert.equal(saved.body.uncappedSupported, false);
    const desired = (await f.call('get', '/api/pc-boost/bandwidth/bridge')).body;
    assert.deepEqual(desired.desired, rates);
    const confirmed = await f.call('post', '/api/pc-boost/bandwidth/readback', {
      revision: desired.revision, observed: rates, proof: 'tc_qdisc',
    });
    assert.equal(confirmed.statusCode, 200);
    const status = (await f.call('get', '/api/pc-boost/bandwidth')).body;
    assert.equal(status.status, 'active');
    assert.deepEqual(status.observed, rates);
    assert.equal(status.proof, 'tc_qdisc');
    const changed = await f.call('patch', '/api/pc-boost/bandwidth', { upMbit: 50 });
    assert.equal(changed.body.status, 'pending');
    await f.call('post', '/api/pc-boost/bandwidth/readback', { revision: desired.revision, observed: rates, proof: 'tc_qdisc' });
    assert.equal((await f.call('get', '/api/pc-boost/bandwidth')).body.status, 'pending');
    now += 21000;
    assert.equal((await f.call('get', '/api/pc-boost/bandwidth')).body.status, 'bridge_offline');
  } finally { f.db.close(); }
});
test('fractional existing file values can be observed without modifying them; malicious acknowledgements fail closed', { skip: !available }, async () => {
  const f = fixture();
  try {
    const response = await f.call('post', '/api/pc-boost/bandwidth/readback', { revision: null,
      observed: { downMbit: 119.5, upMbit: 36.5 }, proof: 'tc_qdisc' });
    assert.equal(response.statusCode, 200);
    assert.equal((await f.call('get', '/api/pc-boost/bandwidth')).body.status, 'unmanaged');
    for (const body of [{ revision: null, observed: { ...rates, token: 'secret' } },
      { revision: null, observed: { ...rates, upMbit: 0 } },
      { revision: null, observed: rates, token: 'secret' },
      { revision: 123, observed: rates }]) {
      assert.equal((await f.call('post', '/api/pc-boost/bandwidth/readback', body)).statusCode, 400);
    }
  } finally { f.db.close(); }
});
test('only the token-authenticated bridge routes precede native session/CSRF middleware', { skip: !available }, async () => {
  const expressRequire = createRequire('C:/Users/user/Documents/Codex/2026-10-07/sag/work/vidiq-api/package.json');
  const express = expressRequire('express');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => req.headers['x-test-owner'] === '1' ? next() : res.status(401).json({ error: 'native session' }));
  app.use('/api', (req, res, next) => req.method === 'GET' || req.headers['x-test-csrf'] === '1' ? next() : res.status(403).json({ error: 'native csrf' }));
  const db = database();
  const owner = (req, res, next) => req.headers['x-test-owner'] === '1' ? next() : res.sendStatus(403);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  api.installBandwidthControls({ app, db, requireOwner: owner, readToken: () => 'fixture-token' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/pc-boost/bandwidth/bridge', { headers: { authorization: 'Bearer fixture-token' } })).status, 200);
    assert.equal((await fetch(base + '/api/pc-boost/bandwidth/bridge')).status, 401);
    assert.equal((await fetch(base + '/api/pc-boost/bandwidth', { headers: { authorization: 'Bearer fixture-token' } })).status, 401);
    assert.equal((await fetch(base + '/api/pc-boost/bandwidth', { headers: { 'x-test-owner': '1' } })).status, 200);
    assert.equal((await fetch(base + '/api/pc-boost/bandwidth', { method: 'PATCH', headers: {
      'x-test-owner': '1', 'content-type': 'application/json' }, body: JSON.stringify(rates) })).status, 403);
    assert.equal((await fetch(base + '/api/pc-boost/bandwidth/readback', { method: 'POST', headers: {
      authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
      body: JSON.stringify({ revision: null, observed: rates, proof: 'tc_qdisc' }) })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('total tunnel limits cover both workers and cannot be confirmed by the old FFmpeg-only file bridge', async () => {
  const f = fixture();
  try {
    const status = (await f.call('get', '/api/pc-boost/bandwidth')).body;
    assert.equal(status.scope, 'home_boost_tunnel');
    assert.equal(status.proof, 'tc_qdisc');
    assert.equal((await f.call('post', '/api/pc-boost/bandwidth/readback', {
      revision: null, observed: rates,
    })).statusCode, 400);
    assert.equal((await f.call('post', '/api/pc-boost/bandwidth/readback', {
      revision: null, observed: rates, proof: 'tc_qdisc',
    })).statusCode, 200);
  } finally { f.db.close(); }
});
