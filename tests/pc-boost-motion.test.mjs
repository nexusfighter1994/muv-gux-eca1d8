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
  for (const patch of [{ motionSlots: 0 }, { motionSlots: 5 }, { motionSlots: 2.5 }, { motionHomeShare: 49 }, { motionHomeShare: 201 }, { motionHomeShare: '80' }]) {
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
  assert.deepEqual(motionLimits({ motionSlots: 7, motionHomeShare: 20 }), { motionSlots: 2, motionHomeShare: 70 });
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
