'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {install, homeReady} = require('../node/siglip-server-total-cap.cjs');

function fixture() {
  const lane = {activeTotal: 21}, home = {active: 20};
  let connected = true, limit = 1;
  const queue = {
    stats: () => ({...home}),
    serverView(fn) {
      const saved = lane.activeTotal;
      lane.activeTotal -= home.active;
      try { return fn(); } finally { lane.activeTotal = saved; }
    },
  };
  const scheduler = {stats: () => ({siglip: {size: 10, active: lane.activeTotal - home.active}, render: {size: 9}})};
  const guard = install({queue, scheduler, getState: () => lane, ready: () => connected, cap: () => limit});
  return {lane, home, queue, scheduler, guard, connect: v => connected = v, limit: v => limit = v};
}

test('all native admissions are held at one while Home is connected', () => {
  const f = fixture();
  for (const kind of ['embedding', 'OCR', 'recovery']) {
    let called = false;
    assert.equal(f.queue.serverView(() => { called = true; return null; }), 'lane', kind);
    assert.equal(called, false);
    assert.equal(f.lane.activeTotal, 21);
  }
});
test('Home parent scopes including recovery parents do not consume the native slot', () => {
  const f = fixture(); f.lane.activeTotal = 20;
  assert.equal(f.queue.serverView(() => null), null);
  assert.equal(f.queue.stats().server.active, 0);
  assert.equal(f.queue.stats().active, 20);
  assert.equal(f.lane.activeTotal, 20);
});
test('existing native tasks drain without cancellation or accounting mutation', () => {
  const f = fixture(); f.lane.activeTotal = 30;
  for (let active = 30; active > 20; active--) {
    f.lane.activeTotal = active;
    assert.equal(f.queue.serverView(() => null), 'lane');
    assert.equal(f.lane.activeTotal, active);
  }
  f.lane.activeTotal = 20;
  assert.equal(f.queue.serverView(() => 'memory'), 'memory');
});
test('disconnect restores native admission and configured size without changing settings', () => {
  const f = fixture(); f.connect(false);
  assert.equal(f.queue.serverView(() => null), null);
  assert.equal(f.scheduler.stats().siglip.size, 10);
  f.connect(true);
  assert.equal(f.scheduler.stats().siglip.size, 1);
  assert.equal(f.scheduler.stats().siglip.configuredSize, 10);
  assert.equal(f.scheduler.stats().render.size, 9);
  assert.equal(f.queue.stats().server.active, 1);
});
test('native exceptions restore accounting and installation is idempotent', () => {
  const f = fixture(); f.lane.activeTotal = 20;
  assert.throws(() => f.queue.serverView(() => { throw Error('native'); }), /native/);
  assert.equal(f.lane.activeTotal, 20);
  assert.equal(install({queue: f.queue}), f.guard);
});
test('legacy zero embedding limit retains one slot for OCR and counted recovery', () => {
  const f = fixture(); f.limit(0);
  assert.equal(f.scheduler.stats().siglip.size, 1);
  f.limit(4);
  assert.equal(f.scheduler.stats().siglip.size, 4);
  assert.equal(f.queue.serverView(() => null), null);
});
test('readiness requires a valid successful fresh Home snapshot', () => {
  const saved = globalThis.__vfHomeSiglipHealth, now = 100000;
  try {
    for (const [health, age, expected] of [[{ready: true}, 1000, true], [{ready: true}, 90000, true], [{ready: true}, 120000, false], [null, 1000, false], [{ready: false}, 1000, false]]) {
      globalThis.__vfHomeSiglipHealth = {snapshot: () => ({health, checkedAt: now - age})};
      assert.equal(homeReady(now), expected);
    }
  } finally { globalThis.__vfHomeSiglipHealth = saved; }
});
