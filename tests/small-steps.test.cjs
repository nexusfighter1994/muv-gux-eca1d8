'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const small = require('../node/small-steps.cjs');
const ram = require('../node/home-ram-estimate.cjs');
const claim = require('../node/home-pool-claim.cjs');

// A real arrow function whose source text is exactly the bundle's bar-detection callback.
function barDetect(calls = []) {
  const u = { detectBars: (path, options) => { calls.push([path, options]); return { bars: false }; } };
  const CKe = null, me = { clipPath: '/data/clip.mp4' }, z = 4;
  void u; void CKe; void me; void z;
  return eval('()=>(u.detectBars||CKe)(me.clipPath,{durationSec:z})');
}
const on = () => ({ enabled: true, floorMb: small.FLOOR_MB });
const off = () => ({ enabled: false, floorMb: small.FLOOR_MB });

function fakeScheduler() {
  const calls = [];
  let gate = Object.assign(async request => ({ allowed: false, wait: { reasonKey: 'app_budget' }, request }), { headroomStats: () => 'inner' });
  const scheduler = {
    run(jobId, resource, callback, options) { calls.push({ jobId, resource, options, self: this }); return callback(); },
    getMemoryGate: () => gate, setMemoryGate: next => { gate = next; },
  };
  scheduler.run.__vfHomeDirect = true;
  return { scheduler, calls };
}

test('only the bar-detection callback is a small step', () => {
  assert.equal(small.isSmallStepCallback(barDetect()), true);
  assert.equal(String(barDetect()), small.BAR_DETECT_SOURCES[0]);
  const a = {}, b = null, c = {}, d = 1; void a; void b; void c; void d;
  assert.equal(small.isSmallStepCallback(eval('()=>(a.detectBars||b)(c.clipPath,{durationSec:d})')), true, 'other minifier names');
  assert.equal(small.isSmallStepCallback(eval('()=>(a.detectBars||b)(c.clipPath)')), false);
  assert.equal(small.isSmallStepCallback(eval('()=>(a.detectBars||b)(c.clipPath,{durationSec:d,extra:1})')), false);
  assert.equal(small.isSmallStepCallback(eval('()=>a(["-y","-i",b,"-vf",c],{timeoutMs:18e4})')), false, 'credit render');
  assert.equal(small.isSmallStepCallback(() => 1), false);
  assert.equal(small.isSmallStepCallback('()=>(u.detectBars||CKe)(me.clipPath,{durationSec:z})'), false, 'strings are not callbacks');
});

test('settings: missing or invalid file is off, read at most once per second, floor is bounded', () => {
  let t = 1000, reads = 0, content = null;
  const settings = small.createSettingsReader({ now: () => t, read: () => { reads++; if (content === null) throw Error('ENOENT'); return content; } });
  assert.deepEqual(settings(), { enabled: false, floorMb: small.FLOOR_MB });
  content = '{"enabled":true,"floorMb":6000}';
  assert.equal(settings().enabled, false, 'cached within the second');
  assert.equal(reads, 1);
  t = 2000;
  assert.deepEqual(settings(), { enabled: true, floorMb: 6000 });
  content = '{"enabled":"yes","floorMb":100}'; t = 3000;
  assert.deepEqual(settings(), { enabled: false, floorMb: small.FLOOR_MB }, 'only true enables; floor below 2048 falls back');
  content = 'not json'; t = 4000;
  assert.equal(settings().enabled, false);
  t = 500;
  content = '{"enabled":true}';
  assert.equal(settings().enabled, true, 'a clock that jumps back re-reads');
});

test('a small step is tagged with priority, its own resource and kind; everything else is untouched', () => {
  const { scheduler, calls } = fakeScheduler();
  const seen = [];
  const api = small.install({ scheduler, settings: on, available: () => 20000 });
  assert.equal(scheduler.run.__vfHomeDirect, true, 'function properties of the previous run survive');
  assert.deepEqual(scheduler.run('job', 'ffmpeg', barDetect(seen)), { bars: false });
  assert.deepEqual(seen, [['/data/clip.mp4', { durationSec: 4 }]]);
  assert.deepEqual(calls[0].options, { interactive: true, resourceKey: 'ffmpegSmall', homeKind: 'small-native', operation: 'small-bar-detect' });
  assert.equal(calls[0].self, scheduler, 'this is kept');
  scheduler.run('job', 'ffmpeg', barDetect(), { signal: 'S', operation: 'given' });
  assert.deepEqual(calls[1].options, { signal: 'S', operation: 'given', interactive: true, resourceKey: 'ffmpegSmall', homeKind: 'small-native' });
  const plain = () => 7, options = { operation: 'x' };
  assert.equal(scheduler.run('job', 'ffmpeg', plain, options), 7);
  assert.equal(calls[2].options, options, 'other ffmpeg calls keep their options object');
  scheduler.run('job', 'siglip', barDetect());
  assert.equal(calls[3].options, undefined, 'other lanes are not touched');
  const routed = { homeKind: 'video-trim' };
  scheduler.run('job', 'ffmpeg', barDetect(), routed);
  assert.equal(calls[4].options, routed, 'a call another module routed is left alone');
  assert.equal(api.stats.tagged, 2);
  assert.equal(api.stats.leftAlone, 1);
  assert.equal(small.install({ scheduler, settings: on }), api, 'idempotent');
  assert.equal(globalThis.__vfSmallSteps, api);
});

test('switched off, the call runs exactly as before and the gate is not wrapped', () => {
  const { scheduler, calls } = fakeScheduler();
  const before = scheduler.getMemoryGate();
  const api = small.install({ scheduler, settings: off, available: () => 20000 });
  scheduler.run('job', 'ffmpeg', barDetect());
  assert.equal(calls[0].options, undefined);
  assert.equal(scheduler.getMemoryGate(), before);
  assert.equal(api.stats.off, 1);
  assert.equal(api.stats.tagged, 0);
});

test('the gate lets a small step pass while real RAM is above the floor, and only then', async () => {
  let available = 9000, enabled = true, inner = 0;
  const gate = Object.assign(async request => { inner++; return { allowed: false, key: request.key }; }, { headroomStats: () => 'inner', __vfRealHeadroomVersion: 'real-headroom-v5' });
  const stats = {};
  const wrapped = small.wrapSmallGate(gate, { available: () => available, settings: () => ({ enabled, floorMb: 4096 }), stats });
  assert.equal(await wrapped({ key: 'ffmpegSmall', lane: 'ffmpeg' }), true);
  assert.equal(inner, 0);
  assert.deepEqual(await wrapped({ key: 'ffmpeg', lane: 'ffmpeg' }), { allowed: false, key: 'ffmpeg' }, 'other keys: inner gate');
  available = 4300;
  assert.deepEqual(await wrapped({ key: 'ffmpegSmall' }), { allowed: false, key: 'ffmpegSmall' }, 'below floor + 256: inner gate');
  available = NaN;
  assert.equal((await wrapped({ key: 'ffmpegSmall' })).allowed, false, 'unreadable meminfo: inner gate');
  available = 9000; enabled = false;
  assert.equal((await wrapped({ key: 'ffmpegSmall' })).allowed, false, 'switched off: inner gate');
  assert.equal(wrapped.headroomStats(), 'inner');
  assert.equal(wrapped.__vfRealHeadroomVersion, 'real-headroom-v5');
  assert.equal(small.wrapSmallGate(wrapped), wrapped, 'idempotent');
  assert.deepEqual(stats, { gatePassed: 1, gateDeferred: 2 });
  assert.throws(() => small.wrapSmallGate(null), TypeError);
});

test('the pass is put back on top when a later installer wraps the gate', async () => {
  const { scheduler } = fakeScheduler();
  const api = small.install({ scheduler, settings: on, available: () => 20000 });
  scheduler.run('job', 'ffmpeg', barDetect());
  const first = scheduler.getMemoryGate();
  assert.equal(first.__vfSmallGate, small.VERSION);
  assert.equal(await first({ key: 'ffmpegSmall' }), true);
  assert.equal(first.headroomStats(), 'inner');
  scheduler.setMemoryGate(async request => ({ allowed: false, outer: true, inner: await first(request) }));
  scheduler.run('job', 'ffmpeg', barDetect());
  assert.equal(scheduler.getMemoryGate().__vfSmallGate, small.VERSION);
  assert.equal(await scheduler.getMemoryGate()({ key: 'ffmpegSmall' }), true);
  assert.equal((await scheduler.getMemoryGate()({ key: 'ffmpeg' })).outer, true);
  assert.equal(api.stats.gatePassed, 2);
});

test('install needs a scheduler', () => {
  assert.throws(() => small.install({}), TypeError);
  assert.throws(() => small.install({ scheduler: {} }), TypeError);
});

test('RAM estimate: a small step reserves 256 MB in the shape of the ffmpeg estimate; the rest is unchanged', () => {
  const seen = [];
  const original = request => { seen.push(request.resourceKey); return { mb: request.resourceKey === 'fflowComposition' ? 2700 : 1100, source: 'learned' }; };
  const estimate = ram.wrapHomeRamEstimate(original);
  assert.deepEqual(estimate({ resourceKey: 'ffmpegSmall', opKey: 'b_roll_video' }), { mb: 256, source: 'learned' });
  assert.equal(seen.at(-1), 'ffmpeg', 'asked as a native ffmpeg slot');
  assert.equal(ram.SMALL_STEP_MB, small.SMALL_MB);
  assert.equal(ram.SMALL_STEP_KEY, small.SMALL_RESOURCE);
  assert.deepEqual(estimate({ resourceKey: 'ffmpeg' }), { mb: 1100, source: 'learned' });
  assert.deepEqual(estimate({ resourceKey: 'ffmpegHome' }), { mb: ram.HOME_DISPATCH_MB, source: 'learned' });
  assert.deepEqual(estimate({ resourceKey: 'ffmpegHomeFallback' }), { mb: 2700, source: 'learned' });
  assert.deepEqual(estimate({ resourceKey: 'ffmpegHomeTrimFallback' }), { mb: 1100, source: 'learned' });
  assert.equal(ram.wrapHomeRamEstimate(estimate), estimate, 'idempotent');
});

test('composition cap: default 10, a runtime value of 1-20 replaces it, anything else is ignored', () => {
  const scopes = n => Array.from({ length: n }, () => ({ kind: 'composition' }));
  let value = null;
  const can = claim.limitCompositions(() => true, { readCap: () => value });
  assert.equal(can({ resourceKey: 'fflowComposition' }, scopes(9)), true);
  assert.equal(can({ resourceKey: 'fflowComposition' }, scopes(10)), false);
  value = 6;
  assert.equal(can({ resourceKey: 'fflowComposition' }, scopes(5)), true);
  assert.equal(can({ resourceKey: 'fflowComposition' }, scopes(6)), false);
  assert.equal(can({ resourceKey: 'ffmpeg', homeKind: 'video-trim' }, scopes(20)), true, 'small work is never capped here');
  for (const bad of [0, 21, 2.5, '6', NaN, undefined]) {
    value = bad;
    assert.equal(can({ resourceKey: 'fflowComposition' }, scopes(9)), true, `ignored: ${bad}`);
    assert.equal(can({ resourceKey: 'fflowComposition' }, scopes(10)), false, `ignored: ${bad}`);
  }
  let t = 1000, reads = 0;
  const reader = claim.createCapReader({ now: () => t, read: () => { reads++; return '{"compositionCap":7}'; } });
  assert.equal(reader(), 7); assert.equal(reader(), 7); assert.equal(reads, 1, 'cached within the second');
  t = 2500; assert.equal(reader(), 7); assert.equal(reads, 2);
  assert.equal(claim.createCapReader({ read: () => { throw Error('ENOENT'); } })(), null);
  assert.equal(claim.createCapReader({ read: () => '{"compositionCap":"x"}' })(), null);
});
