'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../node/home-pool-claim.cjs');

test('claims run ahead of ready pool workers, bounded by Home capacity; none without a ready pool', () => {
  assert.equal(c.claimLimit(24, 6), 12);
  assert.equal(c.claimLimit(24, 2), 6, 'at least ready + 4');
  assert.equal(c.claimLimit(24, 20), 24, 'Home capacity caps it');
  assert.equal(c.claimLimit(24, 0), 0);
  assert.equal(c.claimLimit(0, 6), 0);
});

test('canClaim counts flow scopes only and reads the pool file at most once per second', () => {
  let t = 1000, reads = 0;
  const pool = { mode: 'home-only', ready: true, checkedAt: 1000, readyWorkers: 3 };
  const readPool = c.createPoolReader({ now: () => t, read: () => { reads++; return pool; } });
  const can = c.makeCanClaim({ getCapacity: () => 24, readPool, now: () => t });
  const scopes = n => Array.from({ length: n }, () => ({ kind: 'video-trim' })).concat([{ kind: 'video-normalize' }]);
  assert.equal(can({ homeKind: 'video-trim' }, scopes(6)), true, '6 < max(6, 7)');
  assert.equal(can({ homeKind: 'video-trim' }, scopes(7)), false);
  assert.equal(can({ homeKind: 'video-normalize' }, scopes(30)), true, 'normalize is not pool-bound');
  for (let i = 0; i < 100; i++) can({ homeKind: 'video-trim' }, scopes(1));
  assert.equal(reads, 1, 'cached within the second');
  t = 50000;
  assert.equal(can({ homeKind: 'video-trim' }, scopes(0)), false, 'stale pool (>45 s) admits nothing');
});
