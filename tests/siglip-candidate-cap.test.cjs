'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const capModule = require(process.env.SC_MODULE || '../node/siglip-candidate-cap.cjs');
const headroom = require(process.env.SC_HEADROOM || '../node/siglip-recovery-headroom.cjs');

function world({ capacity = 8, kinds = [] } = {}) {
  const scopes = new Map(); let n = 0, seq = 0;
  const waiters = kinds.map(homeKind => ({ resourceKey: 'siglip', homeKind, jobId: 'job', priority: 1, seq: seq++ }));
  const claimed = [];
  const deps = { getState: () => ({ waiters }), getCapacity: () => capacity, scopes, isAborted: () => false,
    newNonce: () => 'n' + (++n), claim: (w, s) => { waiters.splice(waiters.indexOf(w), 1); claimed.push([w, s]); } };
  return { scopes, waiters, claimed, deps };
}
const candidatesOf = scopes => [...scopes.values()].filter(s => s.candidate).length;

test('cap reader: default 2, valid values 1-12, cached for one second', () => {
  let text = '{"cap":4}', time = 0;
  const read = capModule.createCapReader({ now: () => time, read: () => { if (text === null) throw Error('ENOENT'); return text; } });
  assert.equal(read(), 4);
  text = '{"cap":6}'; time = 500; assert.equal(read(), 4);
  time = 1000; assert.equal(read(), 6);
  for (const bad of ['{"cap":0}', '{"cap":13}', '{"cap":"4"}', '{"cap":2.5}', 'nonsense', '{}', null]) {
    text = bad; time += 1000; assert.equal(read(), 2, String(bad));
  }
  text = '{"cap":12}'; time += 1000; assert.equal(read(), 12);
});

test('with cap 2 the new drain claims exactly what the headroom drain claims', () => {
  const kinds = ['siglip-home-candidate', 'siglip-home', 'siglip-home-candidate', 'siglip-home-candidate', 'siglip-server', 'siglip-home', 'siglip-home-candidate'];
  const a = world({ kinds }), b = world({ kinds });
  const queue = headroom.install({ drain() {}, stats: () => ({ admitted: 0 }) }, a.deps);
  queue.drain();
  capModule.createDrain({ ...b.deps, readCap: () => 2 })();
  assert.deepEqual(a.claimed.map(([w, s]) => [w.seq, s.candidate, s.kind, s.resourceKey]), b.claimed.map(([w, s]) => [w.seq, s.candidate, s.kind, s.resourceKey]));
  assert.equal(candidatesOf(b.scopes), 2);
  assert.deepEqual(b.waiters.map(w => w.homeKind), ['siglip-home-candidate', 'siglip-server', 'siglip-home-candidate']);
});

test('cap 4 admits 4 candidates, never more than the Home capacity', () => {
  const a = world({ kinds: Array(20).fill('siglip-home-candidate') });
  const drain = capModule.createDrain({ ...a.deps, readCap: () => 4 });
  drain();
  assert.equal(candidatesOf(a.scopes), 4);
  assert.equal(drain.admitted(), 4);
  for (const scope of a.scopes.values()) scope.candidate = false;   // callbacks started: confirmed Home embeds
  drain();
  assert.equal(a.scopes.size, 8);                                   // capacity 8 is the limit, not the cap
  drain();
  assert.equal(a.scopes.size, 8);
  const small = world({ capacity: 3, kinds: Array(20).fill('siglip-home-candidate') });
  capModule.createDrain({ ...small.deps, readCap: () => 12 })();
  assert.equal(small.scopes.size, 3);
});

test('recovering scopes do not count as Home scopes; aborted waiters are skipped; a failing claim leaves no scope', () => {
  const a = world({ capacity: 2, kinds: Array(6).fill('siglip-home') });
  a.scopes.set('r1', { recovering: true }); a.scopes.set('r2', { recovering: true });
  capModule.createDrain({ ...a.deps, readCap: () => 2 })();
  assert.equal(a.scopes.size, 4);
  const b = world({ kinds: ['siglip-home', 'siglip-home'] });
  b.waiters[0].signal = { aborted: true };
  capModule.createDrain({ ...b.deps, readCap: () => 2 })();
  assert.deepEqual(b.claimed.map(([w]) => w.seq), [1]);
  const c = world({ kinds: ['siglip-home'] });
  assert.throws(() => capModule.createDrain({ ...c.deps, claim: () => { throw Error('claim failed'); }, readCap: () => 2 })(), /claim failed/);
  assert.equal(c.scopes.size, 0);
});

test('installOn swaps drain and stats on the queue, keeps the admitted total, and restores', () => {
  const a = world({ kinds: Array(10).fill('siglip-home-candidate') });
  const queue = headroom.install({ drain() {}, stats: () => ({ admitted: 100 }) }, a.deps);
  queue.drain();
  assert.equal(queue.stats().admitted, 102);
  const oldDrain = queue.drain;
  const handle = capModule.installOn(queue, a.deps, { readCap: () => 5 });
  assert.equal(handle.version, 'siglip-candidate-cap-v1');
  assert.equal(capModule.installOn(queue, a.deps), handle);
  assert.notEqual(queue.drain, oldDrain);
  queue.drain();
  assert.equal(candidatesOf(a.scopes), 5);
  assert.equal(queue.stats().admitted, 105);
  assert.equal(queue.stats().candidateCap, 5);
  assert.equal(queue.stats().candidateActive, 5);
  handle.restore();
  assert.equal(queue.drain, oldDrain);
  assert.equal(queue.__vfCandidateCap, undefined);
  assert.throws(() => capModule.installOn({}, a.deps), TypeError);
  assert.throws(() => capModule.createDrain({ ...a.deps, scopes: {}, readCap: () => 2 }), TypeError);
});
