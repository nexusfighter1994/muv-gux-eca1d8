import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MODS } from '../node/mod-registry.mjs';
import { installModControls } from '../node/mod-controls.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-mod-wiring-'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const saved = { version: 1, revision: crypto.randomUUID(), changedAt: new Date().toISOString(),
  mods: Object.fromEntries(MODS.filter(mod => !mod.readOnly).map(mod => [mod.id, false])) };
installModControls({ app: { get() {}, patch() {} }, requireOwner() {},
  db: { prepare() { return { get: () => ({ value_json: JSON.stringify(saved) }) }; }, transaction: fn => fn },
  runtimePath: path.join(directory, 'active.json') });
const c = await import('../node/custom.mjs');

test('actual disabled queue and provider mods retain native choices', () => {
  assert.equal(c.maxActiveVideos(), 1000000);
  assert.equal(c.llmAttempts({ provider: 'surplus' }, 2), 2);
  assert.equal(c.retryDelay({ provider: 'surplus' }, 781, {}), 781);
  assert.equal(c.breakerAllows({ provider: 'surplus' }, false), false);
  const chain = [{ provider: 'cli-proxy' }, { provider: 'surplus' }];
  assert.equal(c.surplusFirst(chain, 'text', false, 'scripts'), chain);
});

test('actual disabled native wrappers preserve function identity', () => {
  const original = function () { return this; };
  for (const name of ['wrapMarketCheck', 'wrapComposition', 'extendSourcingBudget',
    'wrapMapAdmissionCheck', 'wrapMapWaiterChoice', 'wrapFfmpegAdmissionCheck', 'wrapHomeRamEstimate',
    'wrapHomeNormalizeExec', 'wrapHomeFflowClient']) assert.equal(c[name](original, {}), original, name);
  assert.equal(c.laneSize('ffmpeg', 14), 14);
  assert.equal(c.workerTarget(14), 14);
  const limits = { ffmpeg: 14 };
  assert.equal(c.engineLimits(limits), limits);
});

test('actual disabled installers do not inspect dependencies or modify jobs', () => {
  const forbidden = new Proxy({}, { get() { throw Error('Disabled installer inspected dependencies'); } });
  for (const name of ['installSheetBatch', 'installEngineRetry', 'installFallbacks', 'installAutoRetry',
    'installHomeAdmission', 'installHomeDirect', 'installHomeLibraryTrim', 'installHomeSiglipStartup', 'installGpuRenderEvents']) {
    assert.doesNotThrow(() => c[name](forbidden), name);
  }
  assert.doesNotThrow(() => c.demoteOverflow(forbidden));
  const hooks = c.createThumbnailOpenluxHooks(forbidden), original = () => 17;
  assert.equal(hooks.wrapCli(original), original);
  assert.equal(hooks.wrapGenerate(original), original);
});

test('actual disabled conversion still rejects unsafe inputs before invoking native concat', async () => {
  let submissions = 0;
  const concat = c.createCompatibleConcat(() => { submissions++; }, {
    probe: async () => JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High 4:4:4 Predictive', pix_fmt: 'yuv420p' }] }),
    run: async () => { submissions++; },
  });
  await assert.rejects(concat({ localPaths: ['/unsafe.mp4'] }), /automatic conversion is disabled/);
  assert.equal(submissions, 0);
});
