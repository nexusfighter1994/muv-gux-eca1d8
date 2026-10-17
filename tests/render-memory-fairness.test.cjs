'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRenderMemoryFairness } = require('../node/render-memory-fairness.cjs');

const START = 1_000_000;
const FFMPEG = { lane: 'ffmpeg', key: 'ffmpeg' };
const RENDER = { lane: 'render', key: 'remotion' };
const KEYS = ['ffmpeg', 'fflowComposition'];
const RECOVERY_KEYS = ['ffmpegHomeFallback', 'ffmpegHomeTrimFallback',
  'ffmpegHomeNormalizeFallback'];

function state() {
  return {
    render: {
      activeTotal: 0,
      waiters: [{ jobId: 'ready', seq: 1, queuedAtMs: START - 60_000 }],
      memoryWait: { reasonKey: 'live_headroom', resourceKey: 'remotion',
        predictedSlotMb: 4024, pendingMb: 12800, availableMb: 20480, reserveMb: 6431 }
    },
    waitingSinceMs: START - 60_000,
    hasReadyRender: true
  };
}

function fixture(original = () => true, options = {}) {
  const f = { time: START, state: state(), calls: [] };
  f.gate = createRenderMemoryFairness(function (...args) {
    f.calls.push({ receiver: this, args });
    return Reflect.apply(original, this, args);
  }, { getState: () => f.state, now: () => f.time, ...options });
  return f;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('delays new native FFmpeg only after the complete 60-second wait', () => {
  for (const reasonKey of ['live_headroom', 'app_budget']) {
    const f = fixture();
    f.state.render.memoryWait.reasonKey = reasonKey;
    f.time--;
    assert.equal(f.gate(FFMPEG), true);
    f.time++;
    const result = f.gate(FFMPEG);
    assert.equal(result.allowed, false);
    assert.equal(result.wait.reasonKey, 'render_fair_turn');
    assert.equal(result.wait.laneKey, 'ffmpeg');
    assert.equal(result.wait.resourceKey, 'ffmpeg');
    assert.equal(result.wait.renderReasonKey, reasonKey);
    assert.equal(f.calls.length, 1, 'delayed requests must not allocate');
  }
});

test('matches only independent native resource keys and the ffmpeg lane', () => {
  const f = fixture();
  for (const key of KEYS) {
    assert.equal(f.gate({ lane: 'ffmpeg', key }).allowed, false, key);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.gate.getStats().drainWindows, 1);
});

function focusedFixture(original = () => true) {
  const f = fixture(original, { getState: request => ({ ...f.state,
    requestPriority: f.jobs.get(request?.jobId)?.priority }) });
  f.jobs = new Map([['oldest', { priority: '0', demand: 0 }],
    ['younger', { priority: '1', demand: 0 }]]);
  f.state.render.waiters = [{ jobId: 'oldest', priority: '0', resourceKey: 'remotion' }];
  f.state.focus = { jobId: 'oldest', priority: '0', hasReadyRender: true };
  return f;
}

test('an oldest zero-demand render defers younger FFmpeg but never its own FFmpeg', () => {
  const f = focusedFixture();
  for (const key of KEYS) {
    assert.equal(f.gate({ ...FFMPEG, key, jobId: 'younger' }).allowed, false);
    assert.equal(f.gate({ ...FFMPEG, key, jobId: 'oldest' }), true);
  }
  assert.equal(f.gate.getStats().drainWindows, 1);
});

test('younger ready renders cannot drain the oldest FFmpeg or unrelated jobs', () => {
  const f = focusedFixture();
  f.state.focus.hasReadyRender = false;
  f.state.render.waiters = [{ jobId: 'younger', priority: '1', resourceKey: 'remotion' }];
  assert.equal(f.gate({ ...FFMPEG, jobId: 'oldest' }), true);
  assert.equal(f.gate({ ...FFMPEG, jobId: 'younger' }), true);
  assert.equal(f.gate.getStats().drainWindows, 0);
});

test('focus readiness must match a real supported waiter with the native priority', () => {
  for (const waiter of [null,
    { jobId: 'younger', priority: '1', resourceKey: 'remotion' },
    { jobId: 'oldest', priority: 'stale', resourceKey: 'remotion' },
    { jobId: 'oldest', priority: '0', resourceKey: 'geomap' }]) {
    const f = focusedFixture();
    f.state.render.waiters = waiter ? [waiter] : [];
    assert.equal(f.gate({ ...FFMPEG, jobId: 'younger' }), true);
  }
});

test('inactive focus immediately ends a drain without freezing lower-priority work', () => {
  const f = focusedFixture();
  assert.equal(f.gate({ ...FFMPEG, jobId: 'younger' }).allowed, false);
  f.state.focus.hasReadyRender = false;
  assert.equal(f.gate({ ...FFMPEG, jobId: 'younger' }), true);
  assert.equal(f.gate.getStats().status, 'cooldown');
});

test('focus replacement or native-priority change closes the old drain', () => {
  for (const change of [s => { s.focus.jobId = 'younger'; },
    s => { s.focus.priority = '-1'; }, s => { delete s.focus; }]) {
    const f = focusedFixture();
    f.gate({ ...FFMPEG, jobId: 'younger' });
    change(f.state);
    assert.equal(f.gate({ ...FFMPEG, jobId: 'younger' }), true);
    assert.equal(f.gate.getStats().status, 'cooldown');
  }
});

test('missing, interactive, equal or earlier request priority cannot be deferred', () => {
  const f = focusedFixture();
  for (const priority of [undefined, '', '0', '-1', 1]) {
    f.jobs.set('other', { priority });
    assert.equal(f.gate({ ...FFMPEG, jobId: 'other' }), true, String(priority));
  }
  assert.equal(f.gate(FFMPEG), true);
  assert.equal(f.gate.getStats().drainWindows, 0);
});

test('present but invalid focus metadata never falls back to lane-wide draining', () => {
  for (const focus of [null, undefined, {}, { jobId: 'oldest', priority: 0, hasReadyRender: true },
    { jobId: 'oldest', priority: '0', hasReadyRender: 'true' }]) {
    const f = focusedFixture();
    f.state.focus = focus;
    assert.equal(f.gate({ ...FFMPEG, jobId: 'younger' }), true);
    assert.equal(f.gate.getStats().drainWindows, 0);
  }
});

test('counted Home recovery always reaches the unchanged native gate, including legacy mode', () => {
  const denied = { allowed: false, wait: { reasonKey: 'pressure' } };
  for (const make of [fixture, focusedFixture]) {
    const f = make(() => denied);
    f.gate({ ...FFMPEG, jobId: 'younger' });
    for (const key of RECOVERY_KEYS) {
      assert.equal(f.gate({ ...FFMPEG, key, jobId: 'younger' }), denied);
    }
  }
});

test('focused draining retains the 60-second wait, 45-second ceiling and 60-second cooldown', () => {
  const f = focusedFixture(), request = { ...FFMPEG, jobId: 'younger' };
  f.time--;
  assert.equal(f.gate(request), true);
  f.time++;
  assert.equal(f.gate(request).allowed, false);
  f.time += 45_000;
  assert.equal(f.gate(request), true);
  f.time += 59_999;
  assert.equal(f.gate(request), true);
  f.time++;
  assert.equal(f.gate(request).allowed, false);
});

test('Home transfers, Home SigLIP, remote resources and every render stay native', () => {
  const token = {};
  const f = fixture(() => token);
  f.gate(FFMPEG);
  const requests = [
    { lane: 'ffmpeg', key: 'ffmpegHome' },
    { lane: 'siglip', key: 'siglipHome' },
    { lane: 'siglip', key: 'siglip' },
    { lane: 'ffmpegHome', key: 'ffmpeg' },
    { lane: 'gpuFfmpeg', key: 'ffmpeg' },
    { lane: 'ffmpeg', key: 'gpuFfmpeg' },
    { lane: 'ffmpeg', key: 'fflow' },
    { lane: 'ffmpeg', key: 'FFMPEG' },
    { lane: 'ffmpeg', resourceKey: 'ffmpeg' },
    ...KEYS.map(key => ({ lane: 'render', key })), RENDER, null, undefined
  ];
  for (const request of requests) assert.equal(f.gate(request), token);
  assert.equal(f.calls.length, requests.length);
});

test('preserves exact receiver, arguments, synchronous results and thrown errors', () => {
  const token = { allowed: false, wait: { reasonKey: 'pressure' } };
  const receiver = { name: 'receiver' }, extra = {}, error = new Error('native');
  const f = fixture(function () { assert.equal(this, receiver); return token; });
  assert.equal(f.gate.call(receiver, RENDER, extra, 17), token);
  assert.deepEqual(f.calls[0], { receiver, args: [RENDER, extra, 17] });
  const g = fixture(() => { throw error; });
  assert.throws(() => g.gate(RENDER), e => e === error);
});

test('every renderer still receives the original memory denial without rewriting it', () => {
  const denied = freeze({ allowed: false, wait: { reasonKey: 'app_budget' } });
  const f = fixture(() => denied);
  f.gate(FFMPEG);
  for (const key of ['remotion', 'frameshift', 'map', 'custom', 'ffmpeg']) {
    assert.equal(f.gate({ lane: 'render', key }), denied);
  }
  assert.equal(f.gate.getStats().status, 'draining');
  assert.equal(f.calls.length, 5);
});

test('requires zero active renders, literal readiness and at least one native waiter', () => {
  const changes = [s => { s.render.activeTotal = 1; }, s => { s.hasReadyRender = false; },
    s => { s.hasReadyRender = 1; }, s => { s.render.waiters = []; },
    s => { s.render.waiters = 512; }, s => { s.render.activeTotal = -1; },
    s => { s.render.activeTotal = '0'; }, s => { s.render.activeTotal = NaN; }];
  for (const change of changes) {
    const f = fixture();
    change(f.state);
    assert.equal(f.gate(FFMPEG), true);
    assert.equal(f.calls.length, 1);
  }
});

test('unsupported or missing memory reasons never start fairness', () => {
  for (const memoryWait of [null, undefined, {}, { reasonKey: 'pressure' },
    { reasonKey: 'render_fair_turn' }, { reasonKey: 'reservation' }]) {
    const f = fixture();
    f.state.render.memoryWait = memoryWait;
    assert.equal(f.gate(FFMPEG), true);
    assert.equal(f.gate.getStats().drainWindows, 0);
  }
});

test('invalid and future waiting timestamps fail toward the original native gate', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '940000', START + 1]) {
    const f = fixture();
    f.state.waitingSinceMs = value;
    assert.equal(f.gate(FFMPEG), true, String(value));
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  f.state.waitingSinceMs = 0;
  assert.equal(f.gate(FFMPEG).allowed, false, 'zero is a valid timestamp');
});

test('state, clock and request getter failures do not introduce a denial or throw', () => {
  const boom = () => { throw new Error('getter failed'); };
  for (const getState of [boom, () => null, () => ({}),
    () => ({ get render() { return boom(); } })]) {
    const f = fixture(() => 'native', { getState });
    assert.equal(f.gate(FFMPEG), 'native');
  }
  for (const now of [boom, () => NaN, () => Infinity, () => '1000000', () => 9e15]) {
    const f = fixture(() => 'native', { now });
    assert.equal(f.gate(FFMPEG), 'native');
  }
  const f = fixture(() => 'native');
  const request = { lane: 'ffmpeg', get key() { return boom(); } };
  assert.equal(f.gate(request), 'native');
  assert.equal(f.calls[0].args[0], request);
});

test('a drain expires at 45 seconds and enforces 60 seconds of cooldown', () => {
  const f = fixture();
  assert.equal(f.gate(FFMPEG).allowed, false);
  f.time = START + 44_999;
  assert.equal(f.gate(FFMPEG).allowed, false);
  f.time = START + 45_000;
  assert.equal(f.gate(FFMPEG), true);
  assert.equal(f.gate.getStats().reason, 'drain_expired');
  f.time = START + 104_999;
  assert.equal(f.gate(FFMPEG), true);
  f.time++;
  assert.equal(f.gate(FFMPEG).allowed, false);
  assert.equal(f.gate.getStats().drainWindows, 2);
});

test('reset observations end draining immediately and cannot bypass cooldown', () => {
  const cases = [
    ['render_active', s => { s.render.activeTotal = 1; }],
    ['no_ready_render', s => { s.hasReadyRender = false; }],
    ['no_render_waiters', s => { s.render.waiters = []; }],
    ['memory_reason_changed', s => { s.render.memoryWait.reasonKey = 'app_budget'; }],
    ['memory_reason_changed', s => { s.render.memoryWait = null; }],
    ['waiting_since_changed', s => { s.waitingSinceMs++; }],
    ['invalid_state', s => { s.render.activeTotal = NaN; }]
  ];
  for (const [reason, change] of cases) {
    const f = fixture();
    f.gate(FFMPEG);
    f.time += 1000;
    change(f.state);
    assert.equal(f.gate(FFMPEG), true, reason);
    assert.equal(f.gate.getStats().status, 'cooldown', reason);
    assert.equal(f.gate.getStats().reason, reason);
    f.state = state();
    f.time += 59_999;
    assert.equal(f.gate(FFMPEG), true, reason);
    f.time++;
    assert.equal(f.gate(FFMPEG).allowed, false, reason);
  }
});

test('continuous new FFmpeg requests cannot extend a drain or its cooldown', () => {
  const f = fixture();
  for (let elapsed = 0; elapsed <= 105_000; elapsed += 1000) {
    f.time = START + elapsed;
    const result = f.gate(FFMPEG);
    assert.equal(result === true, elapsed >= 45_000 && elapsed < 105_000);
  }
  assert.equal(f.gate.getStats().drainWindows, 2);
  assert.equal(f.gate.getStats().delayedRequests, 46);
  assert.equal(f.calls.length, 60);
});

test('literal true and allowed:true render grants close the window immediately', () => {
  for (const grant of [true, { allowed: true }]) {
    const f = fixture(() => grant);
    f.gate(FFMPEG);
    f.time += 1;
    assert.equal(f.gate(RENDER), grant);
    assert.equal(f.gate.getStats().reason, 'render_granted');
    assert.equal(f.gate.getStats().renderGrants, 1);
    assert.equal(f.gate(FFMPEG), grant, 'stale activeTotal=0 must not rearm');
  }
});

test('pending async render grants preserve promise identity and close only on success', async () => {
  const d = deferred(), f = fixture(() => d.promise);
  f.gate(FFMPEG);
  assert.equal(f.gate(RENDER), d.promise);
  assert.equal(f.gate.getStats().status, 'draining');
  assert.equal(f.gate.getStats().pendingRenderChecks, 1);
  assert.equal(f.gate(FFMPEG).allowed, false);
  d.resolve({ allowed: true });
  await d.promise;
  assert.equal(f.gate.getStats().status, 'cooldown');
  assert.equal(f.gate.getStats().pendingRenderChecks, 0);
  assert.equal(f.gate.getStats().reason, 'render_granted');
});

test('native rejection identity and async timing remain intact without a false grant', async () => {
  const d = deferred(), f = fixture(() => d.promise), error = new Error('native rejection');
  f.gate(FFMPEG);
  const returned = f.gate(RENDER);
  assert.equal(returned, d.promise);
  const rejection = assert.rejects(returned, e => e === error);
  d.reject(error);
  await rejection;
  assert.equal(f.gate.getStats().status, 'draining');
  assert.equal(f.gate.getStats().pendingRenderChecks, 0);
  assert.equal(f.gate.getStats().renderGrants, 0);
});

test('async denied, truthy and malformed render results never count as grants', async () => {
  for (const result of [false, { allowed: false }, { allowed: 1 }, 1, null,
    { get allowed() { throw new Error('result getter'); } }]) {
    const promise = Promise.resolve(result), f = fixture(() => promise);
    f.gate(FFMPEG);
    assert.equal(f.gate(RENDER), promise);
    await promise;
    assert.equal(f.gate.getStats().status, 'draining');
    assert.equal(f.gate.getStats().pendingRenderChecks, 0);
    assert.equal(f.gate.getStats().renderGrants, 0);
  }
});

test('a render grant before any effective drain still protects against stale state', async () => {
  const d = deferred(), f = fixture(() => d.promise);
  assert.equal(f.gate(RENDER), d.promise);
  assert.equal(f.gate.getStats().status, 'pending');
  assert.equal(f.gate.getStats().drainWindows, 0);
  d.resolve(true);
  await d.promise;
  assert.equal(f.gate.getStats().status, 'cooldown');
  assert.equal(f.gate(FFMPEG), d.promise);
  assert.equal(f.gate.getStats().drainWindows, 0);
});

test('cross-realm native promises are observed without replacement', async () => {
  const promise = vm.runInNewContext('Promise.resolve({allowed:true})');
  const f = fixture(() => promise);
  f.gate(FFMPEG);
  assert.equal(f.gate(RENDER), promise);
  await promise;
  assert.equal(f.gate.getStats().reason, 'render_granted');
});

test('frozen input and result objects are untouched and denial metadata is whitelisted', () => {
  const f = fixture();
  f.state.render.memoryWait.unsafe = { token: 'not-to-copy' };
  f.state.render.memoryWait.profileKey = { nested: true };
  f.state.render.memoryWait.availableMb = NaN;
  freeze(f.state);
  const before = JSON.stringify(f.state), request = freeze({ ...FFMPEG });
  const denied = f.gate(request);
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(denied.wait.unsafe, undefined);
  assert.equal(denied.wait.profileKey, undefined);
  assert.equal(denied.wait.availableMb, undefined);
  assert.equal(denied.wait.pendingMb, 12800);
  assert.equal(denied.wait.renderPredictedSlotMb, 4024);
  assert.equal(denied.wait.waitingSinceIso, new Date(START - 60_000).toISOString());
  assert(Date.parse(denied.wait.nextRetryAtIso) > START);
  assert(Date.parse(denied.wait.nextRetryAtIso) <= START + 45_000);
  denied.wait.reasonKey = 'mutated';
  assert.equal(f.gate(FFMPEG).wait.reasonKey, 'render_fair_turn');
});

test('compact stats snapshots retain their reason and do not expose mutable internals', () => {
  const f = fixture();
  const pending = f.gate.getStats();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.reason, 'render_waiting');
  f.gate(FFMPEG);
  const draining = f.gate.getStats();
  assert.equal(draining.status, 'draining');
  assert.equal(draining.reason, 'render_fair_turn');
  assert.equal(draining.delayedRequests, 1);
  assert.equal(draining.nativeCalls, 0);
  f.time += 45_000;
  const cooling = f.gate.getStats();
  assert.equal(cooling.status, 'cooldown');
  assert.equal(cooling.reason, 'drain_expired');
  assert.equal(draining.reason, 'render_fair_turn');
  assert.equal(pending.status, 'pending');
  cooling.reason = 'external';
  assert.equal(f.gate.getStats().reason, 'drain_expired');
});

test('duration options may tighten draining or lengthen waits but not break hard bounds', () => {
  const f = fixture(() => true, { waitMs: 120_000, drainMs: 10_000, cooldownMs: 120_000 });
  assert.equal(f.gate(FFMPEG), true);
  f.time += 60_000;
  assert.equal(f.gate(FFMPEG).allowed, false);
  f.time += 10_000;
  assert.equal(f.gate(FFMPEG), true);
  f.time += 119_999;
  assert.equal(f.gate(FFMPEG), true);
  f.time++;
  assert.equal(f.gate(FFMPEG).allowed, false);
  const bounded = fixture(() => true, { waitMs: 1, drainMs: 999_999, cooldownMs: 1 });
  bounded.time--;
  assert.equal(bounded.gate(FFMPEG), true);
  bounded.time++;
  assert.equal(bounded.gate(FFMPEG).allowed, false);
  bounded.time += 45_000;
  assert.equal(bounded.gate(FFMPEG), true);
  bounded.time += 59_999;
  assert.equal(bounded.gate(FFMPEG), true);
  for (const options of [{ drainMs: 0 }, { drainMs: Infinity }, { waitMs: NaN },
    { cooldownMs: -1 }, { getState: null }, { now: null }]) {
    assert.equal(fixture(() => true, options).gate(FFMPEG), true);
  }
});

test('clock reversal or invalid state during draining ends the window without rearming', () => {
  const f = fixture();
  f.gate(FFMPEG);
  f.time--;
  assert.equal(f.gate(FFMPEG), true);
  f.time = START;
  assert.equal(f.gate(FFMPEG), true);
  assert.equal(f.gate.getStats().reason, 'invalid_time');
  const g = fixture();
  g.gate(FFMPEG);
  g.state = null;
  assert.equal(g.gate(FFMPEG), true);
  g.state = state();
  assert.equal(g.gate(FFMPEG), true);
  assert.equal(g.gate.getStats().status, 'cooldown');
});

test('observation is timer-free and a long idle gap does not add a fresh cooldown', () => {
  const timeout = global.setTimeout, interval = global.setInterval;
  global.setTimeout = global.setInterval = () => { throw new Error('unexpected timer'); };
  try {
    const f = fixture();
    f.gate(FFMPEG);
    f.time += 300_000;
    assert.equal(f.gate(FFMPEG).allowed, false);
    assert.equal(f.gate.getStats().drainWindows, 2);
  } finally {
    global.setTimeout = timeout;
    global.setInterval = interval;
  }
});

test('15-second pending reservations drain before a 4024-MiB native render grant', () => {
  const availableMb = 20480, reserveMb = 6431, predictedSlotMb = 4024;
  const reservations = [{ mb: 12800, expires: START + 15000 }];
  let checks = 0, f;
  function nativeGate(request) {
    if (request.lane === 'ffmpeg') {
      reservations.push({ mb: 1024, expires: f.time + 15000 });
      return { allowed: true };
    }
    checks++;
    const pendingMb = reservations.filter(r => r.expires > f.time)
      .reduce((sum, r) => sum + r.mb, 0);
    if (availableMb - predictedSlotMb - pendingMb < reserveMb) {
      return { allowed: false, wait: { reasonKey: 'live_headroom' } };
    }
    return { allowed: true };
  }
  f = fixture(nativeGate);
  assert.equal(f.gate(RENDER).allowed, false, 'native gate reproduces the RAM denial');
  for (let elapsed = 0; elapsed < 15000; elapsed += 1000) {
    f.time = START + elapsed;
    assert.equal(f.gate(FFMPEG).allowed, false);
  }
  assert.equal(reservations.length, 1, 'no new native reservation was allocated');
  f.time = START + 14999;
  assert.equal(f.gate(RENDER).allowed, false, 'no forced render during draining');
  f.time++;
  assert.equal(f.gate(RENDER).allowed, true, 'only the native gate grants rendering');
  assert.equal(checks, 3);
  assert.equal(f.gate.getStats().reason, 'render_granted');
  assert.equal(f.gate(FFMPEG).allowed, true, 'new FFmpeg may allocate during cooldown');
  assert.equal(reservations.length, 2);
});

test('retained snapshots expose stats.reason and distinguish pending from effective', t => {
  const f = fixture();
  assert.equal(typeof f.gate.snapshot, 'function');
  const pending = f.gate.snapshot();
  assert.equal(pending.pending, true);
  assert.equal(pending.effective, false);
  assert.equal(pending.stats.reason, 'render_waiting');
  f.gate(FFMPEG);
  const draining = f.gate.snapshot();
  assert.equal(draining.pending, false);
  assert.equal(draining.effective, true);
  assert.equal(draining.stats.reason, 'render_fair_turn');
  f.time += 45_000;
  const cooling = f.gate.snapshot();
  assert.equal(cooling.pending, false);
  assert.equal(cooling.effective, false);
  assert.equal(cooling.stats.reason, 'drain_expired');
  assert.equal(draining.stats.reason, 'render_fair_turn');
  assert.equal(pending.stats.reason, 'render_waiting');
  t.diagnostic(JSON.stringify({ retainedSnapshots: { pending, draining, cooling } }));
  draining.stats.reason = 'external';
  assert.equal(f.gate.snapshot().stats.reason, 'drain_expired');
});
