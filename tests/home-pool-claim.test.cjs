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

test('scopes parked in server recovery do not count against the pool claim limit', () => {
  const { excludeRecovering, makeCanClaim } = require('../node/home-pool-claim.cjs');
  const pool = { mode: 'home-only', ready: true, checkedAt: Date.now(), readyWorkers: 2 };
  const base = makeCanClaim({ getCapacity: () => 40, readPool: () => pool });
  const scopes = Array.from({ length: 6 }, (_, i) => ({ kind: 'video-trim', nonce: 'n' + i }));
  assert.equal(base({ homeKind: 'video-trim' }, scopes), false); // limit max(4, 6) = 6 reached
  const items = new Map(scopes.slice(0, 4).map((s, i) => [i, { scope: { ...s }, controller: new AbortController() }]));
  const wrapped = excludeRecovering(base, { getItems: () => items });
  assert.equal(wrapped({ homeKind: 'video-trim' }, scopes), true);
  assert.equal(excludeRecovering(wrapped), wrapped);
  const aborted = new AbortController(); aborted.abort();
  const gone = excludeRecovering(base, { getItems: () => new Map([[1, { scope: scopes[0], controller: aborted }]]) });
  assert.equal(gone({ homeKind: 'video-trim' }, scopes), false);
});

test('scene scopes (born as candidates) do not count against the pool claim limit', () => {
  const { poolScopesOnly, makeCanClaim } = require('../node/home-pool-claim.cjs');
  const pool = { mode: 'home-only', ready: true, checkedAt: Date.now(), readyWorkers: 3 };
  const base = makeCanClaim({ getCapacity: () => 40, readPool: () => pool });
  const scenes = Array.from({ length: 10 }, (_, i) => ({ kind: 'video-trim', nonce: 's' + i, candidate: false }));
  assert.equal(base({ homeKind: 'video-trim' }, scenes), false);
  const wrapped = poolScopesOnly(base, { getItems: () => new Map() });
  assert.equal(wrapped({ homeKind: 'video-trim' }, scenes), true);
  const trims = Array.from({ length: 7 }, (_, i) => ({ kind: 'video-trim', nonce: 't' + i }));
  assert.equal(wrapped({ homeKind: 'video-trim' }, [...scenes, ...trims]), false); // real pool scopes still bound
  assert.equal(poolScopesOnly(wrapped), wrapped);
});

test('at most COMPOSITION_CAP compositions are claimed for Home, small work is unaffected', () => {
  const { limitCompositions, COMPOSITION_CAP } = c;
  const can = limitCompositions(() => true);
  const scopes = Array.from({ length: COMPOSITION_CAP }, () => ({ kind: 'composition' }));
  assert.equal(can({ resourceKey: 'fflowComposition' }, scopes), false);
  assert.equal(can({ resourceKey: 'fflowComposition' }, scopes.slice(1)), true);
  assert.equal(can({ resourceKey: 'ffmpeg', homeKind: 'video-trim' }, scopes), true);
  assert.equal(limitCompositions(can), can);
  assert.equal(limitCompositions(() => false)({ homeKind: 'video-trim' }, []), false, 'inner limit still applies');
});
