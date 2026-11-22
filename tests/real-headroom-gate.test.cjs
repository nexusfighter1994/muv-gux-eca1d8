'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRealHeadroomGate, createSettingsReader, VERSION } = require(path.join(__dirname, '../node/real-headroom-gate.cjs'));

// Real 2026-11-05 04:2x refusal: estimates said full, 27.9 GB were really free.
const wait = (extra = {}) => ({ reasonKey: 'app_budget', laneKey: 'ffmpeg', resourceKey: 'ffmpeg',
  predictedSlotMb: 2236, availableMb: 27920, reserveMb: 2048, pendingMb: 7666, budgetMb: 51444,
  activeEstimatedMb: 43622, ...extra });
const refuse = extra => ({ allowed: false, wait: wait(extra) });
const on = () => ({ enabled: true, floorMb: 12288 });
function gate(result, { available = () => 28000, now = () => 1000, settings = on } = {}) {
  let calls = 0;
  const native = async () => { calls++; return typeof result === 'function' ? result() : result; };
  const wrapped = createRealHeadroomGate(native, { available, now, settings });
  return { wrapped, calls: () => calls };
}
const req = { key: 'ffmpeg', lane: 'ffmpeg', jobId: 'j' };

test('app_budget refusal with real headroom is admitted', async () => {
  const { wrapped, calls } = gate(refuse());
  assert.deepEqual(await wrapped(req), { allowed: true });
  assert.equal(calls(), 1);
  assert.equal(wrapped.headroomStats().overrides, 1);
});
test('native grants and non-budget refusals pass through unchanged', async () => {
  for (const result of [true, { allowed: true }, refuse({ reasonKey: 'pressure' }),
    refuse({ reasonKey: 'live_headroom' }), refuse({ reasonKey: 'render_fair_turn' })]) {
    assert.deepEqual(await gate(result).wrapped(req), result);
  }
});
test('refusal is kept when real free RAM after the slot is below the floor', async () => {
  // 20000 - 2236 - 7666 = 10098 < 12288
  const { wrapped } = gate(refuse({ availableMb: 20000 }));
  assert.equal((await wrapped(req)).allowed, false);
  assert.equal(wrapped.headroomStats().kept, 1);
});
test('the lower of native and /proc free RAM decides', async () => {
  const { wrapped } = gate(refuse(), { available: () => 15000 });
  assert.equal((await wrapped(req)).allowed, false);
});
// Native books every admitted slot as pending until it warms up, so pending grows with each grant.
function booking(free = 27920, basePending = 7666) {
  let admitted = 0;
  const wrapped = createRealHeadroomGate(async () => refuse({ availableMb: free, pendingMb: basePending + 2236 * admitted }),
    { available: () => free, now: () => 1000, settings: on });
  return async () => { const ok = (await wrapped(req)).allowed; if (ok) admitted++; return ok; };
}
test('a burst stops once native pending (which holds the new slots) reaches the floor', async () => {
  // 27920 - 2236 - (7666 + 2236k) >= 12288 for k = 0, 1, 2 only.
  const admit = booking();
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await admit());
  assert.deepEqual(results, [true, true, true, false]);
});
test('slots still pending natively are not subtracted a second time as recent admissions', async () => {
  // 31178 - 2236 - (9408 + 2236k) >= 12288 for k <= 3; v2 also subtracted 2236k again: k <= 1.
  const admit = booking(31178, 9408);
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await admit());
  assert.deepEqual(results, [true, true, true, true, false]);
});
test('recent admissions still count after native pending dropped (RSS ramp-up)', async () => {
  let at = 1000;
  const { wrapped } = gate(refuse({ pendingMb: 0 }), { now: () => at });
  // 27920 - 2236 - recent >= 12288 while recent <= 13396: six grants of 2236, then refused.
  const results = [];
  for (let i = 0; i < 7; i++) results.push((await wrapped(req)).allowed);
  assert.deepEqual(results, [true, true, true, true, true, true, false]);
  at += 20000;
  assert.equal((await wrapped(req)).allowed, true);
});
test('disabled switch, invalid numbers and unreadable meminfo keep native refusals', async () => {
  assert.equal((await gate(refuse(), { settings: () => ({ enabled: false, floorMb: 12288 }) }).wrapped(req)).allowed, false);
  assert.equal((await gate(refuse({ predictedSlotMb: null })).wrapped(req)).allowed, false);
  assert.equal((await gate(refuse({ availableMb: null })).wrapped(req)).allowed, false);
  assert.equal((await gate(refuse(), { available: () => NaN }).wrapped(req)).allowed, false);
});
test('a reserve above the floor is honoured', async () => {
  const { wrapped } = gate(refuse({ reserveMb: 19000 }));
  assert.equal((await wrapped(req)).allowed, false);
});
test('synchronous inner refusals (render fairness) are handled without a promise', () => {
  const inner = () => refuse();
  const wrapped = createRealHeadroomGate(inner, { available: () => 28000, now: () => 1, settings: on });
  assert.deepEqual(wrapped(req), { allowed: true });
  const fair = () => refuse({ reasonKey: 'render_fair_turn' });
  assert.equal(createRealHeadroomGate(fair, { settings: on })(req).allowed, false);
});
test('wrapping is idempotent and inner observers stay reachable', () => {
  const inner = async () => true;
  inner.getStats = () => ({ status: 'idle' });
  inner.snapshot = () => ({ pending: false });
  const once = createRealHeadroomGate(inner, { settings: on });
  assert.equal(createRealHeadroomGate(once, { settings: on }), once);
  assert.deepEqual(once.getStats(), { status: 'idle' });
  assert.deepEqual(once.snapshot(), { pending: false });
  assert.equal(once.original, inner);
});
test('a recently refused render slot is reserved against other lanes until it is admitted', async () => {
  let at = 1000, free = 18000;
  const { wrapped } = gate(() => refuse({ availableMb: free, pendingMb: 0 }), { now: () => at, available: () => free });
  // render needs 3000: 18000-3000 = 15000 >= 12288 -> admitted; make it fail first with less free RAM
  free = 15000;
  assert.equal((await wrapped({ lane: 'render', key: 'frameshift' })).allowed, true);
  free = 14000;
  const big = createRealHeadroomGate(async () => refuse({ availableMb: free, pendingMb: 0, predictedSlotMb: 3000 }),
    { now: () => at, available: () => free, settings: on });
  assert.equal((await big({ lane: 'render', key: 'frameshift' })).allowed, false); // 14000-3000 < 12288
  free = 16000;
  // ffmpeg (2236) alone would fit (16000-2236=13764) but must leave the 3000 MB render slot free
  assert.equal((await big({ lane: 'ffmpeg', key: 'ffmpeg' })).allowed, false);
  assert.equal(big.headroomStats().renderReserved, 1);
  assert.equal((await big({ lane: 'render', key: 'frameshift' })).allowed, true); // 16000-3000 >= 12288
  assert.equal((await big({ lane: 'ffmpeg', key: 'ffmpeg' })).allowed, false); // recent render grant counted
  at += 20000; free = 30000;
  assert.equal((await big({ lane: 'ffmpeg', key: 'ffmpeg' })).allowed, true);
});
test('render reservation expires when no render refusal is seen', async () => {
  let at = 1000, free = 14000;
  const g = createRealHeadroomGate(async () => refuse({ availableMb: free, pendingMb: 0, predictedSlotMb: 3000 }),
    { now: () => at, available: () => free, settings: on });
  await g({ lane: 'render' });
  at += 16000; free = 16000;
  assert.equal((await g({ lane: 'ffmpeg' })).allowed, true);
});
test('an older gate version is unwrapped instead of stacked', () => {
  const inner = async () => true;
  const v2 = Object.assign(async () => true, { __vfRealHeadroomVersion: 'real-headroom-v2', original: inner });
  const v3 = createRealHeadroomGate(v2, { settings: on });
  assert.equal(v3.original, inner);
  assert.equal(v3.__vfRealHeadroomVersion, VERSION);
});
test('settings file: default on, explicit off, bounded floor, cached for 1 s', () => {
  let at = 0, body = null, reads = 0;
  const read = () => { reads++; if (body === null) throw Error('missing'); return body; };
  const settings = createSettingsReader({ now: () => at, read });
  assert.deepEqual(settings(), { enabled: true, floorMb: 12288, recentMs: 20000, pendingShare: 1, renderLiveHeadroom: false, renderHoldMs: 15000 });
  body = '{"enabled":false}'; assert.equal(settings().enabled, true);
  at = 1000; assert.deepEqual(settings(), { enabled: false, floorMb: 12288, recentMs: 20000, pendingShare: 1, renderLiveHeadroom: false, renderHoldMs: 15000 });
  body = '{"floorMb":1000}'; at = 2000; assert.equal(settings().floorMb, 12288);
  body = '{"floorMb":16384}'; at = 3000; assert.equal(settings().floorMb, 16384);
  assert.equal(reads, 4);
});
test('recentMs from the settings file: bounded, defaults to 20 s', () => {
  let at = 0, body = '{"recentMs":10000}';
  const settings = createSettingsReader({ now: () => at, read: () => body });
  assert.equal(settings().recentMs, 10000);
  for (const bad of ['{"recentMs":1000}', '{"recentMs":90000}', '{"recentMs":"x"}', '{}']) {
    body = bad; at += 1000; assert.equal(settings().recentMs, 20000);
  }
});
test('a 10 s window releases recent grants after 10 s instead of 20 s', async () => {
  let at = 1000;
  const short = () => ({ enabled: true, floorMb: 12288, recentMs: 10000 });
  const { wrapped } = gate(refuse({ pendingMb: 0 }), { now: () => at, settings: short });
  const results = [];
  for (let i = 0; i < 7; i++) results.push((await wrapped(req)).allowed);
  assert.deepEqual(results, [true, true, true, true, true, true, false]);
  at += 10000;
  assert.equal((await wrapped(req)).allowed, true);
  assert.equal(wrapped.headroomStats().settings.recentMs, 10000);
  assert.equal(wrapped.headroomStats().recentMb, 2236);
});
test('the 20 s default still holds grants at 10 s', async () => {
  let at = 1000;
  const { wrapped } = gate(refuse({ pendingMb: 0 }), { now: () => at });
  for (let i = 0; i < 6; i++) await wrapped(req);
  at += 10000;
  assert.equal((await wrapped(req)).allowed, false);
});
test('pendingShare from the settings file: bounded, defaults to 1', () => {
  let at = 0, body = '{"pendingShare":0.5}';
  const settings = createSettingsReader({ now: () => at, read: () => body });
  assert.equal(settings().pendingShare, 0.5);
  for (const bad of ['{"pendingShare":0}', '{"pendingShare":0.05}', '{"pendingShare":1.5}', '{"pendingShare":"x"}', '{}']) {
    body = bad; at += 1000; assert.equal(settings().pendingShare, 1);
  }
});
test('live 08:47Z case: 31 GB phantom pending refuses at share 1, admits at 0.5', async () => {
  // availableNow 33809, real 30000, ffmpeg 3383, pending 31369, floor 8192.
  const live = refuse({ availableMb: 33809, predictedSlotMb: 3383, pendingMb: 31369 });
  const full = () => ({ enabled: true, floorMb: 8192, recentMs: 10000, pendingShare: 1 });
  const half = () => ({ enabled: true, floorMb: 8192, recentMs: 10000, pendingShare: 0.5 });
  assert.equal((await gate(live, { available: () => 30000, settings: full }).wrapped(req)).allowed, false);
  // 30000 - 3383 - 15684.5 = 10932 >= 8192
  assert.equal((await gate(live, { available: () => 30000, settings: half }).wrapped(req)).allowed, true);
});
test('real free RAM still refuses even with a small pendingShare', async () => {
  const live = refuse({ availableMb: 33809, predictedSlotMb: 3383, pendingMb: 31369 });
  const tenth = () => ({ enabled: true, floorMb: 8192, recentMs: 10000, pendingShare: 0.1 });
  // real 12000: 12000 - 3383 - 3137 = 5480 < 8192
  assert.equal((await gate(live, { available: () => 12000, settings: tenth }).wrapped(req)).allowed, false);
});
test('recent overrides still bound a burst when pendingShare is low', async () => {
  let at = 1000;
  const tenth = () => ({ enabled: true, floorMb: 8192, recentMs: 10000, pendingShare: 0.1 });
  const { wrapped } = gate(refuse({ availableMb: 33809, predictedSlotMb: 3383, pendingMb: 0 }), { now: () => at, available: () => 30000, settings: tenth });
  const results = [];
  for (let i = 0; i < 8; i++) results.push((await wrapped(req)).allowed);
  // 30000 - 3383 - 3383k >= 8192 for k <= 5
  assert.deepEqual(results, [true, true, true, true, true, true, false, false]);
});

test('v6: render live_headroom refusal is admitted only with renderLiveHeadroom and real headroom', async () => {
  const live = { reasonKey: 'live_headroom', laneKey: 'render', predictedSlotMb: 2689, availableMb: 17000, pendingMb: 13900, reserveMb: 2048 };
  const renderReq = { key: 'frameshift', lane: 'render', jobId: 'j' };
  const flagOn = () => ({ enabled: true, floorMb: 8192, pendingShare: 0.25, renderLiveHeadroom: true });
  const flagOff = () => ({ enabled: true, floorMb: 8192, pendingShare: 0.25, renderLiveHeadroom: false });
  // 17000 - 2689 - 13900*0.25 = 10836 >= 8192
  const a = gate({ allowed: false, wait: live }, { available: () => 17000, settings: flagOn });
  assert.deepEqual(await a.wrapped(renderReq), { allowed: true });
  assert.equal(a.wrapped.headroomStats().renderLiveOverrides, 1);
  const b = gate({ allowed: false, wait: live }, { available: () => 17000, settings: flagOff });
  assert.equal((await b.wrapped(renderReq)).allowed, false);
  const c = gate({ allowed: false, wait: { ...live, laneKey: 'ffmpeg' } }, { available: () => 17000, settings: flagOn });
  assert.equal((await c.wrapped({ key: 'ffmpeg', lane: 'ffmpeg', jobId: 'j' })).allowed, false);
  const d = gate({ allowed: false, wait: live }, { available: () => 12000, settings: flagOn });
  assert.equal((await d.wrapped(renderReq)).allowed, false);   // 12000 - 2689 - 3475 = 5836 < 8192
});
test('v6: settings reader exposes renderLiveHeadroom only when true', () => {
  assert.equal(createSettingsReader({ read: () => JSON.stringify({ renderLiveHeadroom: true }) })().renderLiveHeadroom, true);
  assert.equal(createSettingsReader({ read: () => JSON.stringify({ renderLiveHeadroom: 'yes' }) })().renderLiveHeadroom, false);
});
test('v7: renderHoldMs keeps a refused render slot reserved across the render retry gap', async () => {
  let at = 1000, free = 14000;
  const hold = ms => () => ({ enabled: true, floorMb: 10240, pendingShare: 0.25, renderHoldMs: ms });
  const mk = ms => createRealHeadroomGate(async () => refuse({ availableMb: free, pendingMb: 0, predictedSlotMb: 3872 }),
    { now: () => at, available: () => free, settings: hold(ms) });
  for (const [ms, expected] of [[undefined, true], [60000, false]]) {
    at = 1000; free = 14000;
    const g = mk(ms);
    assert.equal((await g({ lane: 'render', key: 'frameshift' })).allowed, false);   // 14000-3872 < 10240
    at += 30000; free = 14500;   // render retries only every ~36 s; ffmpeg (2236) asks in between
    assert.equal((await g({ lane: 'ffmpeg', key: 'ffmpeg' })).allowed, expected, `hold ${ms}`);
  }
  assert.equal(createSettingsReader({ read: () => '{"renderHoldMs":60000}' })().renderHoldMs, 60000);
  assert.equal(createSettingsReader({ read: () => '{"renderHoldMs":999999}' })().renderHoldMs, 15000);
  assert.equal(createSettingsReader({ read: () => '{"renderHoldMs":1000}' })().renderHoldMs, 15000);
});
test('v8: renderFloorMb lowers the floor for render slots only', async () => {
  const cfg = rf => () => ({ enabled: true, floorMb: 10240, pendingShare: 0.25, ...(rf ? { renderFloorMb: rf } : {}) });
  const live = { predictedSlotMb: 3872, availableMb: 13500, pendingMb: 5000, reserveMb: 2048 };
  const render = { lane: 'render', key: 'frameshift' }, ffmpeg = { lane: 'ffmpeg', key: 'ffmpeg' };
  // 13500 - 3872 - 5000*0.25 = 8378: below 10240, above 7168
  assert.equal((await gate(refuse(live), { available: () => 13500, settings: cfg() }).wrapped(render)).allowed, false);
  assert.equal((await gate(refuse(live), { available: () => 13500, settings: cfg(7168) }).wrapped(render)).allowed, true);
  // ffmpeg keeps floorMb: 13500 - 2236 - 1250 = 10014 < 10240
  assert.equal((await gate(refuse({ ...live, predictedSlotMb: 2236 }), { available: () => 13500, settings: cfg(7168) }).wrapped(ffmpeg)).allowed, false);
  // real free RAM still decides
  assert.equal((await gate(refuse(live), { available: () => 11000, settings: cfg(7168) }).wrapped(render)).allowed, false);
  assert.equal(createSettingsReader({ read: () => '{"renderFloorMb":7168}' })().renderFloorMb, 7168);
  assert.equal('renderFloorMb' in createSettingsReader({ read: () => '{"renderFloorMb":1000}' })(), false);
});
test('v9: hardFloorMb vetoes native grants while real free RAM is below it; off by default', async () => {
  const hard = hf => () => ({ enabled: true, floorMb: 12288, ...(hf ? { hardFloorMb: hf } : {}) });
  const reqC = { key: 'fflowComposition', lane: 'ffmpeg', jobId: 'j' };
  // native says yes, 6 GB really free, hard floor 8 GB -> refused with a wait object the scheduler can show
  const a = gate(true, { available: () => 6000, settings: hard(8192) });
  const r = await a.wrapped(reqC);
  assert.equal(r.allowed, false); assert.equal(r.wait.reasonKey, 'app_budget'); assert.equal(r.wait.availableMb, 6000);
  assert.equal(a.wrapped.headroomStats().hardKept, 1);
  // enough free RAM, or no hard floor: native grant passes
  assert.equal(await gate(true, { available: () => 9000, settings: hard(8192) }).wrapped(reqC), true);
  assert.deepEqual(await gate({ allowed: true }, { available: () => 500, settings: hard(0) }).wrapped(reqC), { allowed: true });
  // unreadable meminfo never blocks
  assert.equal(await gate(true, { available: () => NaN, settings: hard(8192) }).wrapped(reqC), true);
  assert.equal(createSettingsReader({ read: () => '{"hardFloorMb":8192}' })().hardFloorMb, 8192);
  assert.equal('hardFloorMb' in createSettingsReader({ read: () => '{"hardFloorMb":100}' })(), false);
});
