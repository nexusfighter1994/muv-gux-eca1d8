'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  delete globalThis.__vfSiglipNativeCap;
  delete require.cache[require.resolve('../node/siglip-native-cap.cjs')];
  return require('../node/siglip-native-cap.cjs');
}

// The native scan (ubi) as in the bundle: first admissible waiter, stops at the first refusal
// unless it is "resource" and skipCapped is set.
function nativeDispatch(admission) {
  return (lane, s, limit, skipCapped) => {
    let reason = null;
    for (const w of s.waiters) {
      const a = admission(lane, w.jobId, limit, w.resourceKey, w.priority);
      if (a === null) return { waiter: w, reason: null };
      reason = a;
      if (!(a === 'resource' && skipCapped)) return { waiter: null, reason: a };
    }
    return { waiter: null, reason };
  };
}

const waiter = (id, homeKind, leases) => ({ jobId: 'j' + id, id, homeKind, resourceKey: 'siglip', priority: 'p', resolve: lease => leases.push([id, lease]) });

test('below the cap or with the PC down the native scan is unchanged', () => {
  const cap = fresh(), leases = [];
  const admit = () => null;
  const lane = { activeTotal: 0, waiters: [waiter(1, 'siglip-home', leases), waiter(2, 'siglip-server', leases)] };
  for (const ready of [() => true, () => false]) {
    const d = cap.wrapDispatch(nativeDispatch(admit), () => admit, ready);
    assert.equal(d('siglip', lane, 13, false).waiter.id, 1);
  }
  const other = cap.wrapDispatch(nativeDispatch(admit), () => admit, () => true);
  assert.equal(other('render', { waiters: [{ id: 9 }] }, 1, false).waiter.id, 9, 'other lanes untouched');
});

test('a native embedding admission is counted until its release; then embeddings wait for the PC', () => {
  const cap = fresh(), leases = [];
  const admit = () => null;
  const d = cap.wrapDispatch(nativeDispatch(admit), () => admit, () => true);
  const lane = { activeTotal: 0, waiters: [waiter(1, 'siglip-home', leases), waiter(2, 'siglip-home', leases), waiter(3, 'siglip-server', leases)] };
  const first = d('siglip', lane, 13, false).waiter;
  assert.equal(first.id, 1);
  first.resolve({ cooldownProbe: false, boosted: false });          // native admission (pbi)
  lane.waiters.shift(); lane.activeTotal = 1;
  assert.deepEqual(leases[0], [1, { cooldownProbe: false, boosted: false, homeScope: cap.TOKEN }]);
  assert.equal(cap.state.active, 1);
  const next = d('siglip', lane, 13, false);
  assert.equal(next.waiter.id, 3, 'OCR passes the waiting embedding');
  assert.deepEqual(lane.waiters.map(w => w.id), [3, 2], 'embeddings move behind OCR (memory branch order)');
  lane.waiters.shift();
  assert.deepEqual(d('siglip', lane, 13, false), { waiter: null, reason: 'resource' });
  assert.equal(cap.state.held, 1);
  // release strips the token so the native release sees an unboosted lease
  let seen;
  const release = cap.wrapRelease((lane_, job, ok, res, boosted) => { seen = boosted; });
  release('siglip', 'j1', true, 'siglip', cap.TOKEN);
  assert.equal(seen, false);
  assert.equal(cap.state.active, 0);
  assert.equal(d('siglip', lane, 13, false).waiter.id, 2, 'cap free again');
});

test('a Home claim (homeScope set) is never counted as native', () => {
  const cap = fresh(), leases = [];
  const w = waiter(1, 'siglip-home', leases);
  cap.tag([w]);
  const scope = { nonce: 'n', jobId: 'j1' };
  w.resolve({ boosted: false, homeScope: scope });
  assert.equal(leases[0][1].homeScope, scope);
  assert.equal(cap.state.active, 0);
});

test('refusals keep native semantics and a lost release cannot pin the cap', () => {
  const cap = fresh(), leases = [];
  const d = cap.wrapDispatch(nativeDispatch(() => 'lane'), () => () => 'lane', () => true);
  cap.state.active = 5;
  const lane = { activeTotal: 1, waiters: [waiter(1, 'siglip-home', leases), waiter(2, 'siglip-server', leases)] };
  assert.deepEqual(d('siglip', lane, 13, false), { waiter: null, reason: 'lane' });
  assert.equal(cap.state.active, 1, 'clamped to the lane\'s active leases');
  lane.activeTotal = 0;
  const d2 = cap.wrapDispatch(nativeDispatch(() => null), () => () => null, () => true);
  assert.equal(d2('siglip', lane, 13, false).waiter.id, 2, 'below the cap again: plain native scan (order from the last cap pass)');
  assert.equal(cap.state.active, 0);
  assert.equal(cap.wrapDispatch(d2, () => null), d2, 'idempotent');
});

test('readiness: a successful Home probe within 30 s, even if the latest probe failed', () => {
  const cap = fresh(), now = 1_000_000;
  const saved = globalThis.__vfHomeSiglipHealth;
  try {
    for (const [snapshot, ready] of [[{ health: null, checkedAt: now - 5000 }, true], [{ health: {}, checkedAt: now - 29000 }, true],
      [{ health: {}, checkedAt: now - 31000 }, false], [{ health: null, checkedAt: 0 }, false]]) {
      globalThis.__vfHomeSiglipHealth = { snapshot: () => snapshot };
      assert.equal(cap.homeReady(now), ready, JSON.stringify(snapshot));
    }
    delete globalThis.__vfHomeSiglipHealth;
    assert.equal(cap.homeReady(now), false);
  } finally { globalThis.__vfHomeSiglipHealth = saved; }
});

test('the cap follows the siglipServerEmbeds setting; an older inner cap wrapper never applies its own 1', () => {
  const cap = fresh(), leases = [];
  let limit = 3;
  const admit = () => null;
  const inner = cap.wrapDispatch(nativeDispatch(admit), () => admit, () => true, () => 1);
  inner.__vfNativeCap = false;  // as the hot install re-wraps an earlier wrapper
  const outer = cap.wrapDispatch(inner, () => admit, () => true, () => limit);
  const lane = { activeTotal: 9, waiters: [waiter(1, 'siglip-home', leases), waiter(2, 'siglip-home', leases), waiter(3, 'siglip-server', leases)] };
  cap.state.active = 2;
  assert.equal(outer('siglip', lane, 13, false).waiter.id, 1, 'below 3: the inner wrapper (cap 1) does not hold the embedding back');
  assert.equal(cap.state.active, 2, 'active count restored after the plain scan');
  assert.equal(cap.state.limit, 3);
  limit = 2;
  assert.equal(outer('siglip', lane, 13, false).waiter.id, 3, 'at 2/2: OCR only');
  limit = 0; cap.state.active = 0;
  assert.equal(outer('siglip', lane, 13, false).waiter.id, 3, '0 = every embedding waits for the PC');
});

test('configuredLimit reads the published setting with a 1 s.. 2 s cache and safe default', () => {
  const cap = fresh();
  assert.equal(cap.configuredLimit(10_000, () => ({ siglipServerEmbeds: 4 })), 4);
  assert.equal(cap.configuredLimit(11_000, () => ({ siglipServerEmbeds: 9 })), 4, 'cached');
  assert.equal(cap.configuredLimit(13_000, () => ({ siglipServerEmbeds: 26 })), 1, 'out of range -> default');
  assert.equal(cap.configuredLimit(16_000, () => { throw Error('missing'); }), 1);
  assert.equal(cap.configuredLimit(19_000, () => ({ siglipServerEmbeds: 0 })), 0);
});
