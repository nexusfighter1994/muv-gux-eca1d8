import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = new URL('../node/mod-registry.mjs', import.meta.url);
const registry = fs.existsSync(url) ? await import(url.href) : {};
const ids = [
  'queueLimit', 'autoRetry', 'surplusRouting', 'surplusRetry', 'marketGuard',
  'thumbnailOpenlux', 'thumbnailIdentity', 'fishFree', 'ai33Stt', 'sourcingDeadline', 'chunkWatchdog',
  'sheetBatch', 'restage', 'fallbacks', 'engineRetry', 'mapAdmission', 'ffmpegAdmission',
  'mapIsolation', 'streamCompat', 'gpuEvents', 'homeQueue', 'homeFfmpeg', 'homeSiglip',
  'homeScenes', 'homeMap', 'homeMotion', 'serverBoost', 'slotCleanup', 'fxRetention', 'fxSentinel',
];

test('registry contains exactly the approved toggle IDs and read-only infrastructure', () => {
  assert.ok(Array.isArray(registry.MODS), 'MODS must be exported');
  assert.deepEqual(registry.MODS.filter(mod => !mod.readOnly).map(mod => mod.id), ids);
  const core = registry.MODS.filter(mod => mod.readOnly);
  assert.equal(core.length, 1);
  assert.equal(core[0].id, 'coreInfrastructure');
  assert.ok(core[0].alwaysOnReason);
  assert.deepEqual(core[0].hooks, ['node.routes', 'ui.inject']);
});

test('every toggle defaults true and requires restart, with valid group and descriptions', () => {
  assert.ok(Array.isArray(registry.GROUPS), 'GROUPS must be exported');
  assert.deepEqual(registry.GROUPS.map(group => group.id), ['production', 'providers', 'rendering', 'home', 'safety']);
  const groups = new Set(registry.GROUPS.map(group => group.id));
  for (const mod of registry.MODS) {
    assert.ok(groups.has(mod.group), mod.id);
    assert.ok(mod.title.length > 2 && mod.description.length > 15, mod.id);
    assert.equal(mod.defaultEnabled, true, mod.id);
    assert.equal(mod.restartRequired, !mod.readOnly, mod.id);
  }
});

test('registry and always-on correctness fixes account for all 40 build-contract hooks', () => {
  const contract = fs.readFileSync(new URL('../validate-hook-report.py', import.meta.url), 'utf8');
  const required = [...contract.split('REQUIRED_HOOKS = (')[1].split(')')[0].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.equal(required.length, 40);
  const hooks = (registry.MODS || []).flatMap(mod => mod.hooks)
    .concat(['node.etaDisplay', 'render.infographicTimeline']);
  assert.deepEqual([...new Set(hooks)].sort(), required.sort());
  assert.deepEqual(registry.MODS.find(mod => mod.id === 'serverBoost').hooks,
    ['node.lane', 'node.workerTarget', 'node.engineSync', 'node.wake']);
  assert.ok(registry.MODS.find(mod => mod.id === 'homeSiglip').description.includes('independent'));
});

test('metadata cannot be mutated by a settings consumer', () => {
  assert.ok(Object.isFrozen(registry.MODS));
  assert.ok(Object.isFrozen(registry.GROUPS));
  for (const mod of registry.MODS) {
    assert.ok(Object.isFrozen(mod));
    assert.ok(Object.isFrozen(mod.hooks));
    assert.throws(() => { mod.hooks.push('invented'); }, TypeError);
  }
});

test('AVC toggle is conversion-only and never disables strict incompatible-input rejection', () => {
  const compat = registry.MODS.find(mod => mod.id === 'streamCompat');
  assert.match(compat.description, /automatic conversion/i);
  assert.match(compat.description, /strict.*rejection.*always/i);
  assert.equal(compat.defaultEnabled, true);
});
