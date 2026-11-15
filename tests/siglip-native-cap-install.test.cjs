'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fresh() {
  delete globalThis.__vfSiglipNativeCap;
  delete require.cache[require.resolve('../node/siglip-native-cap.cjs')];
  return require('../node/siglip-native-cap.cjs');
}

test('late dispatcher publication is retried and then bound exactly once', () => {
  const cap = fresh();
  let dispatch, writes = 0;
  const ensure = cap.createDispatchInstaller(() => () => null, {
    getDispatch: () => dispatch,
    setDispatch: value => { dispatch = value; writes++; },
  });
  assert.equal(ensure(), false);
  dispatch = () => ({waiter: null, reason: 'lane'});
  assert.equal(ensure(), true);
  const installed = dispatch;
  assert.equal(ensure(), true);
  assert.equal(dispatch, installed);
  assert.equal(writes, 1);
  assert.equal(dispatch.__vfNativeCap, true);
});

test('a later dispatcher replacement is rebound without changing native lanes', () => {
  const cap = fresh();
  const received = [];
  let dispatch = (...args) => { received.push(args); return {waiter: 'native', reason: null}; };
  const ensure = cap.createDispatchInstaller(() => () => null, {
    getDispatch: () => dispatch, setDispatch: value => { dispatch = value; },
  });
  ensure();
  const first = dispatch;
  dispatch = (...args) => first(...args);
  ensure();
  const rebound = dispatch;
  ensure();
  assert.equal(dispatch, rebound);
  assert.deepEqual(dispatch('render', {}, 9, true), {waiter: 'native', reason: null});
  assert.deepEqual(received, [['render', {}, 9, true]]);
});

test('published binding enforces configured cap and keeps release accounting', () => {
  const cap = fresh();
  const saved = globalThis.__vfHomeSiglipHealth;
  const savedPath = process.env.VF_PC_BOOST_CONFIG;
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vf-cap-'));
  try {
    process.env.VF_PC_BOOST_CONFIG = path.join(tmp, 'config.json');
    fs.writeFileSync(process.env.VF_PC_BOOST_CONFIG, JSON.stringify({siglipServerEmbeds: 3}));
    globalThis.__vfHomeSiglipHealth = {snapshot: () => ({checkedAt: Date.now()})};
    let dispatch = (_lane, state) => ({waiter: state.waiters[0], reason: null});
    const ensure = cap.createDispatchInstaller(() => () => null, {
      getDispatch: () => dispatch, setDispatch: value => { dispatch = value; },
    });
    ensure();
    const leases = [];
    const state = {activeTotal: 0, waiters: []};
    for (let i = 0; i < 3; i++) {
      state.waiters = [{id: i, homeKind: 'siglip-home', resolve: lease => leases.push(lease)}];
      const next = dispatch('siglip', state, 10, true).waiter;
      assert.ok(next);
      state.activeTotal++;
      next.resolve({});
    }
    state.waiters = [{homeKind: 'siglip-home', resolve: () => {}}];
    assert.equal(dispatch('siglip', state, 10, true).waiter, null);
    assert.equal(cap.state.limit, 3);
    assert.equal(cap.state.active, 3);
    cap.releaseToken('siglip', leases[0].homeScope);
    state.activeTotal--;
    assert.ok(dispatch('siglip', state, 10, true).waiter);
    assert.equal(cap.state.active, 2);
  } finally {
    globalThis.__vfHomeSiglipHealth = saved;
    if (savedPath === undefined) delete process.env.VF_PC_BOOST_CONFIG;
    else process.env.VF_PC_BOOST_CONFIG = savedPath;
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('Home SigLIP maintenance retries the binding after startup', () => {
  const source = fs.readFileSync(path.join(__dirname, '../node/home-siglip.mjs'), 'utf8');
  assert.match(source, /const ensureNativeCap=siglipNativeCap\.createDispatchInstaller\(getAdmission\)/);
  assert.match(source, /schedule\(\(\)=>\{ensureNativeCap\(\);queue\.recoveries\(\)\.sweep\(\);queue\.drain\(\);\}\)/);
});
