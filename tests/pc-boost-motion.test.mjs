import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as api from '../node/pc-boost-api.mjs';
import { installMotionOffload } from '../node/home-graphics/motion-offload/server-integration.mjs';

const require = createRequire('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/signalforge-recovered/package.json');
const Database = require('better-sqlite3');
const { motionLimits, withMotionLimits } = createRequire(import.meta.url)('../node/home-graphics/motion-offload/motion-limits.cjs');

test('withMotionLimits keeps the live configuration (contract) and adds the limits per call', () => {
  const live = { contract: 'one', getToken: () => 't', getSettings: () => ({ homeMotion: true }) };
  let file = '{"motionSlots":3,"motionHomeShare":85}';
  const getConfig = withMotionLimits(() => live, '/x/pc-boost.json', () => file);
  assert.equal(getConfig().contract, 'one');
  live.contract = 'two';
  assert.equal(getConfig().contract, 'two', 'contract hot changes stay visible');
  assert.deepEqual(getConfig().getSettings(), { homeMotion: true, motionSlots: 3, motionHomeShare: 85 });
  file = 'not json';
  assert.deepEqual(getConfig().getSettings(), { homeMotion: true, motionSlots: 2, motionHomeShare: 70 });
  assert.equal(withMotionLimits(() => null)(), null);
});

function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  return db;
}
const row = (db, key) => JSON.parse(db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key).value_json);

test('motion settings are bounded (slots 1..4, Home share 50..200 %) and default to 2 / 70', () => {
  assert.equal(api.DEFAULT_CONFIG.motionSlots, 2);
  assert.equal(api.DEFAULT_CONFIG.motionHomeShare, 70);
  assert.equal(api.validateConfig({ motionSlots: 4, motionHomeShare: 90 }).motionSlots, 4);
  assert.equal(api.validateConfig({ motionHomeShare: 200 }).motionHomeShare, 200);
  for (const patch of [{ motionSlots: 0 }, { motionSlots: 9 }, { motionSlots: 2.5 }, { motionHomeShare: 49 }, { motionHomeShare: 201 }, { motionHomeShare: '80' }]) {
    assert.throws(() => api.validateConfig(patch), error => error.status === 400, JSON.stringify(patch));
  }
  assert.ok(!api.PC_CONFIG_KEYS.includes('motionSlots') && !api.PC_CONFIG_KEYS.includes('motionHomeShare'), 'server-side only, never pushed to Home');
});

test('motion keys live in their own row; the pc_boost row stays readable by older images', () => {
  const db = database();
  const published = [];
  const store = api.createConfigStore({ db, publish: config => published.push(config) });
  const next = store.update({ enabled: true, motionSlots: 3, motionHomeShare: 85 });
  assert.equal(next.motionSlots, 3);
  assert.deepEqual(row(db, 'pc_motion'), { motionSlots: 3, motionHomeShare: 85 });
  const pc = row(db, 'pc_boost');
  assert.ok(!('motionSlots' in pc) && !('motionHomeShare' in pc));
  assert.equal(pc.enabled, true);
  assert.equal(published.at(-1).motionHomeShare, 85, 'runtime file carries the motion limits');
  const reopened = api.createConfigStore({ db, publish() {} }).get();
  assert.equal(reopened.motionSlots, 3);
  assert.equal(reopened.enabled, true);
});

test('a legacy pc_boost row (written before this change) loads with motion defaults; a corrupt motion row keeps PC Boost', () => {
  const db = database();
  db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('pc_boost', JSON.stringify({ enabled: true, cpuWorkers: 18, gpuWorkers: 6,
    siglipEnabled: true, siglipConcurrency: 14, sceneWorkers: 0, clipvaultBoost: 35, ffmpegBoost: 14 }));
  db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('pc_motion', JSON.stringify({ motionSlots: 9 }));
  const config = api.createConfigStore({ db, publish() {} }).get();
  assert.equal(config.enabled, true);
  assert.equal(config.cpuWorkers, 18);
  assert.equal(config.motionSlots, 2);
  assert.equal(config.motionHomeShare, 70);
});

test('motionLimits reads the published runtime file values with safe fallbacks', () => {
  assert.deepEqual(motionLimits({ motionSlots: 4, motionHomeShare: 90 }), { motionSlots: 4, motionHomeShare: 90 });
  assert.deepEqual(motionLimits({ motionSlots: 8, motionHomeShare: 200 }), { motionSlots: 8, motionHomeShare: 200 });
  assert.deepEqual(motionLimits({ motionSlots: 9, motionHomeShare: 20 }), { motionSlots: 2, motionHomeShare: 70 });
  assert.deepEqual(motionLimits({ motionSlots: 1, motionHomeShare: 150 }), { motionSlots: 1, motionHomeShare: 150 });
  assert.equal(motionLimits({ motionHomeShare: 201 }).motionHomeShare, 70);
  assert.deepEqual(motionLimits(null), { motionSlots: 2, motionHomeShare: 70 });
});

test('motion configuration getSettings exposes the live limits from pc-boost.json on every call', () => {
  let state = { enabled: true, motionSlots: 3, motionHomeShare: 80 };
  let configured;
  const readFile = file => { const name = String(file); return name.endsWith('motion-contract.json') ? JSON.stringify({ contract: 'a'.repeat(64) })
    : name.endsWith('pc-boost-token') ? 't'.repeat(32) : JSON.stringify(state); };
  const result = installMotionOffload({ modEnabled: () => true, env: {}, readFile, configure: c => { configured = c; } });
  assert.equal(result.installed, true);
  assert.deepEqual(configured.getSettings(), { homeMotion: true, motionSlots: 3, motionHomeShare: 80 });
  state = { enabled: true, motionSlots: 4, motionHomeShare: 90 };
  assert.deepEqual(configured.getSettings(), { homeMotion: true, motionSlots: 4, motionHomeShare: 90 });
  state = { enabled: false };
  assert.deepEqual(configured.getSettings(), { homeMotion: false, motionSlots: 2, motionHomeShare: 70 });
});

test('burst settings: own pc_burst row, bounds, stop below start, write-only API key', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-burst-'));
  const secretPath = path.join(dir, 'runpod-api-key');
  try {
    const db = database();
    const published = [];
    const store = api.createConfigStore({ db, publish: c => published.push(c), secretPath });
    assert.equal(store.get().burstEnabled, false);
    assert.equal(store.get().burstApiKeySet, false);
    const next = store.update({ burstEnabled: true, burstStartQueue: 150, burstMaxCents: 30, burstApiKey: 'rpa_ABCDEFGHIJKLMNOPQRSTUV0123' });
    assert.equal(next.burstEnabled, true);
    assert.equal(next.burstApiKeySet, true);
    assert.ok(!('burstApiKey' in next), 'the key is never returned');
    assert.equal(fs.readFileSync(secretPath, 'utf8'), 'rpa_ABCDEFGHIJKLMNOPQRSTUV0123');
    assert.ok(!JSON.stringify(published).includes('rpa_'), 'the key never reaches the runtime file');
    assert.deepEqual(row(db, 'pc_burst'), { burstEnabled: true, burstStartQueue: 150, burstStopQueue: 10, burstMaxCents: 30, burstMaxHours: 12, burstGpuTypes: [] });
    assert.deepEqual(store.update({ burstGpuTypes: ['NVIDIA RTX A4000', 'NVIDIA GeForce RTX 3090'] }).burstGpuTypes, ['NVIDIA RTX A4000', 'NVIDIA GeForce RTX 3090']);
    for (const bad of [['a', 'a'], [5], ['x;rm'], 'NVIDIA']) assert.throws(() => store.update({ burstGpuTypes: bad }), error => error.status === 400, JSON.stringify(bad));
    assert.ok(!('burstEnabled' in row(db, 'pc_boost')), 'pc_boost row keeps the old shape');
    assert.ok(!JSON.stringify(db.prepare('SELECT value_json FROM app_settings').all()).includes('rpa_'), 'the key is not in the database');
    for (const patch of [{ burstStopQueue: 150 }, { burstMaxCents: 4 }, { burstMaxHours: 25 }, { burstApiKey: 'short' }, { burstApiKey: 7 }, { burstApiKey: 'has spaces in it padding' }]) {
      assert.throws(() => store.update(patch), error => error.status === 400, JSON.stringify(patch));
    }
    assert.equal(fs.readFileSync(secretPath, 'utf8'), 'rpa_ABCDEFGHIJKLMNOPQRSTUV0123', 'a rejected patch keeps the key');
    assert.equal(store.update({ burstApiKey: '' }).burstApiKeySet, false, 'empty removes the key');
    assert.equal(api.createConfigStore({ db, publish() {}, secretPath }).get().burstStartQueue, 150, 'reopened from pc_burst');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('siglipServerEmbeds: 0..25, default 1, own settings row', () => {
  assert.equal(api.DEFAULT_CONFIG.siglipServerEmbeds, 1);
  assert.equal(api.validateConfig({ siglipServerEmbeds: 0 }).siglipServerEmbeds, 0);
  assert.equal(api.validateConfig({ siglipServerEmbeds: 25 }).siglipServerEmbeds, 25);
  for (const value of [-1, 26, 2.5, '3']) assert.throws(() => api.validateConfig({ siglipServerEmbeds: value }));
  assert.deepEqual(api.SIGLIP_SERVER_KEYS, ['siglipServerEmbeds']);
  assert.ok(!api.PC_CONFIG_KEYS.includes('siglipServerEmbeds'), 'never pushed to the PC');
});

test('earlyPhasePriority: boolean, default on, own settings row', () => {
  assert.equal(api.DEFAULT_CONFIG.earlyPhasePriority, true);
  assert.equal(api.validateConfig({ earlyPhasePriority: false }).earlyPhasePriority, false);
  for (const value of [1, 'true', null]) assert.throws(() => api.validateConfig({ earlyPhasePriority: value }));
  assert.deepEqual(api.SCHEDULING_KEYS, ['earlyPhasePriority']);
  assert.ok(!api.PC_CONFIG_KEYS.includes('earlyPhasePriority'));
});
