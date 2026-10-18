'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installHomeCapsSmoothing } = require('../node/home-caps-smoothing.cjs');

test('last ready capabilities survive 2 failed probes and a stalled loop up to 45 s', () => {
  let t = 1000;
  delete globalThis.__vfHomeCapsSmoothing;
  globalThis.__vfHomeCapabilities = { ready: true, checkedAt: 1000, capacity: 24 };
  installHomeCapsSmoothing({ now: () => t });
  t = 20000;
  assert.deepEqual(globalThis.__vfHomeCapabilities, { ready: true, checkedAt: 20000, capacity: 24 }, 'stale 19 s but under 45 s');
  globalThis.__vfHomeCapabilities = { ready: false, checkedAt: 20000, capacity: 0 };
  globalThis.__vfHomeCapabilities = { ready: false, checkedAt: 23000, capacity: 0 };
  assert.equal(globalThis.__vfHomeCapabilities.ready, true, 'two failures keep Home');
  globalThis.__vfHomeCapabilities = { ready: false, checkedAt: 26000, capacity: 0 };
  assert.equal(globalThis.__vfHomeCapabilities.ready, false, 'third failure stops dispatch');
  globalThis.__vfHomeCapabilities = { ready: true, checkedAt: 30000, capacity: 18 };
  t = 80000;
  assert.equal(globalThis.__vfHomeCapabilities.checkedAt, 30000, 'older than 45 s: reported as it is');
  delete globalThis.__vfHomeCapsSmoothing;
  Object.defineProperty(globalThis, '__vfHomeCapabilities', { configurable: true, writable: true, value: undefined });
});
