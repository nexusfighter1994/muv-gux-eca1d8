'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStallBreaker, guardBreaker, rawDispatchCapacity } = require(path.join(__dirname, '../node/home-dispatch-limit.cjs'));

function setup(initial) {
  let t = 0, s = { capacity: 50, active: 50, queued: 7000, admitted: 100, ...initial }, logs = [];
  const breaker = createStallBreaker({ stats: () => s, now: () => t, log: m => logs.push(m),
    stallMs: 300e3, cooldownMs: 300e3, sampleMs: 5000 });
  return { breaker, logs, at: v => { t = v; }, set: patch => { s = { ...s, ...patch }; } };
}

test('a full Home queue that releases nothing for 5 min while work waits is paused for 5 min', () => {
  const { breaker, logs, at } = setup();
  for (let t = 0; t < 300e3; t += 5000) { at(t); assert.equal(breaker.allow(), true); }
  at(300e3); assert.equal(breaker.allow(), false);
  assert.equal(breaker.state.trips, 1);
  assert.match(logs[0], /no new Home work for 5 min/);
  at(450e3); assert.equal(breaker.allow(), false);
  at(600e3); assert.equal(breaker.allow(), true, 'closes after the cooldown');
});

test('any released slot (admitted grows) counts as progress', () => {
  const { breaker, at, set } = setup();
  for (let t = 0; t <= 600e3; t += 5000) { at(t); set({ admitted: 100 + Math.floor(t / 60e3) }); assert.equal(breaker.allow(), true); }
  assert.equal(breaker.state.trips, 0);
});

test('a half-empty queue or no waiting work never trips', () => {
  for (const patch of [{ active: 20 }, { queued: 0 }]) {
    const { breaker, at } = setup(patch);
    for (let t = 0; t <= 900e3; t += 5000) { at(t); assert.equal(breaker.allow(), true); }
  }
});

test('the guarded capacity is 0 while open and unchanged otherwise; stats re-entry does not recurse', () => {
  let open = false, calls = 0;
  const fake = { state: { version: 'x' }, allow: () => { calls++; return !open; } };
  const capacity = guardBreaker(() => 40, { breaker: fake });
  assert.equal(capacity(), 40);
  open = true; assert.equal(capacity(), 0);
  assert.equal(guardBreaker(capacity), capacity);
  // stats() of the real queue calls the capacity again: the sampler must not re-enter itself.
  let t = 0, depth = 0;
  const real = createStallBreaker({ now: () => t, stats: () => { depth++; real.allow(); return { capacity: 50, active: 50, queued: 1, admitted: 1 }; } });
  assert.equal(real.allow(), true);
  assert.equal(depth, 1);
});

test('dispatch is at most 2x Home run slots, configured slots stay an upper bound', () => {
  const health = { ready: true, capacity: 22, checkedAt: 1000 };
  assert.equal(rawDispatchCapacity(health, 40, 2000, 0), 40);
  assert.equal(rawDispatchCapacity({ ...health, capacity: 12 }, 40, 2000, 0), 24);
  assert.equal(rawDispatchCapacity(health, 20, 2000, 0), 20);
  assert.equal(rawDispatchCapacity(health, 40, 2000, 5), 45, 'running recoveries add their slot back');
  assert.equal(rawDispatchCapacity(health, 40, 2000, -8), 32, 'waiting recoveries brake dispatch');
  assert.equal(rawDispatchCapacity(health, 4, 2000, -24), 1, 'never below 1 while Home is ready');
  assert.equal(rawDispatchCapacity({ ...health, ready: false }, 40, 2000, 3), 0);
});
test('recovery adjustment: waiting recoveries brake, running ones add', () => {
  const item = started => ({ started, controller: { signal: { aborted: false } } });
  const { recoveryAdjustment } = require(path.join(__dirname, '../node/home-dispatch-limit.cjs'));
  assert.equal(recoveryAdjustment(new Map([[1, item(true)], [2, item(true)]])), 2);
  assert.equal(recoveryAdjustment(new Map([[1, item(true)], [2, item(false)], [3, item(false)]])), -2);
  assert.equal(recoveryAdjustment(new Map([[1, { started: false, controller: { signal: { aborted: true } } }]])), 0);
  assert.equal(recoveryAdjustment(undefined), 0);
});
