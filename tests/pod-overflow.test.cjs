'use strict';
const assert = require('node:assert');
const M = require('../node/pod-overflow.cjs');

const base = { cfg: { ...M.DEFAULTS }, workload: 'brollAnalysis', operation: 'B-roll shot trim', remote: false, poolOn: true,
  podFree: 0, podSlots: 16, podWaiters: 20, homeCapacity: 48, homeActive: 10, homeQueued: 0, localInFlight: 0 };
const d = over => M.decide({ ...base, ...over });

(async () => {
  // decide: the pod keeps first call
  assert.strictEqual(d({}), 'home');
  assert.strictEqual(d({ operation: 'B-roll shot trim (footage reuse)' }), 'home');
  assert.strictEqual(d({ cfg: { ...M.DEFAULTS, enabled: false } }), 'off');
  assert.strictEqual(d({ workload: 'animations' }), 'other work');
  assert.strictEqual(d({ operation: 'B-roll shot detection' }), 'other work');
  assert.strictEqual(d({ remote: true }), 'native');
  assert.strictEqual(d({ poolOn: false }), 'native');
  assert.strictEqual(d({ podFree: 1 }), 'pod free');
  assert.strictEqual(d({ podWaiters: 7 }), 'pod queue short', '16 slots x 0.5 = 8 waiters must stay queued for the pod');
  assert.strictEqual(d({ podWaiters: 8 }), 'home');
  assert.strictEqual(d({ podSlots: 0, podWaiters: 3 }), 'pod queue short', 'booting pods: still at least minPodWaiters');
  assert.strictEqual(d({ podSlots: 0, podWaiters: 4 }), 'home', 'pods still booting: Home works meanwhile');
  assert.strictEqual(d({ homeCapacity: 0 }), 'home away');
  assert.strictEqual(d({ homeActive: 48 }), 'home full');
  assert.strictEqual(d({ homeQueued: 6 }), 'home queue');
  assert.strictEqual(d({ localInFlight: 32 }), 'local limit');

  // knob
  assert.deepStrictEqual(M.readKnob('x', () => { throw new Error('ENOENT'); }), M.DEFAULTS);
  assert.deepStrictEqual(M.readKnob('x', () => '{"enabled":false,"minPodWaiters":10,"waiterFactor":1,"maxHomeQueued":12,"maxLocal":20}'),
    { enabled: false, minPodWaiters: 10, waiterFactor: 1, maxHomeQueued: 12, maxLocal: 20 });
  assert.deepStrictEqual(M.readKnob('x', () => '{"minPodWaiters":-1,"waiterFactor":"x","maxHomeQueued":0,"maxLocal":9999}'), M.DEFAULTS);
  assert.deepStrictEqual(M.readKnob('x', () => 'not json'), M.DEFAULTS);

  // createPodOverflow with fakes
  let t = 1e6, remote = false, on = true, waiting = 20, homeReads = 0;
  const pods = [{ state: 'ready', inflight: 8 }, { state: 'ready', inflight: 8 }, { state: 'booting', inflight: 0 }, { state: 'ready', inflight: 0, capabilities: { fflow: false } }];
  const home = { capacity: 48, active: 10, queuedKinds: { 'video-trim': 0, 'video-normalize': 900 } };
  const o = M.createPodOverflow({ isRemote: () => remote, poolOn: w => on && w === 'brollAnalysis', pods: () => pods, slotsOf: () => 8,
    waiters: () => waiting, homeStats: () => { homeReads += 1; return home; }, settings: () => ({ ...M.DEFAULTS }), now: () => t });
  const trim = { jobId: 'j1', operation: 'B-roll shot trim', workload: 'brollAnalysis' };

  assert.strictEqual(o.shouldRunLocal({ ...trim, workload: 'animations' }), false);
  assert.strictEqual(o.shouldRunLocal({ ...trim, jobId: null }), false);
  assert.strictEqual(homeReads, 0, 'other work never reads the Home queue');
  assert.strictEqual(o.shouldRunLocal(trim), true);
  // a burst inside one second: the cached Home queue count grows with what was sent, so the burst stops at maxHomeQueued
  let sent = 1;
  for (let i = 0; i < 20; i += 1) if (o.shouldRunLocal(trim)) sent += 1;
  assert.strictEqual(sent, 6, 'burst limited to maxHomeQueued');
  assert.strictEqual(homeReads, 1, 'Home stats read once per second');
  assert.strictEqual(o.stats.pod['home queue'], 15);
  t += 1000;
  assert.strictEqual(o.shouldRunLocal(trim), true, 'next second: fresh Home state');
  pods[0].inflight = 7;
  assert.strictEqual(o.shouldRunLocal(trim), false, 'a free pod slot wins');
  assert.strictEqual(o.stats.pod['pod free'], 1);
  pods[0].inflight = 8; waiting = 7;
  assert.strictEqual(o.shouldRunLocal(trim), false);
  assert.strictEqual(o.stats.pod['pod queue short'], 1);
  waiting = 20; remote = true;
  assert.strictEqual(o.shouldRunLocal(trim), false);
  remote = false; on = false;
  assert.strictEqual(o.shouldRunLocal(trim), false);
  assert.strictEqual(o.stats.pod.native, 2);
  on = true;

  // a pod without the fflow service does not count as capacity: all usable slots busy -> Home
  t += 1000;
  assert.strictEqual(o.shouldRunLocal(trim), true);

  // runLocal: counts, passes result and error through
  let release;
  const p = o.runLocal(() => new Promise(r => { release = r; }));
  assert.strictEqual(o.stats.localInFlight, 1);
  t += 4000; release('ok');
  assert.strictEqual(await p, 'ok');
  assert.deepStrictEqual([o.stats.localInFlight, o.stats.localDone, o.stats.localAvgSec], [0, 1, 4]);
  await assert.rejects(o.runLocal(async () => { throw new Error('boom'); }), /boom/);
  assert.deepStrictEqual([o.stats.localInFlight, o.stats.localFailed], [0, 1]);

  // errors inside the probes never send work anywhere new
  const broken = M.createPodOverflow({ isRemote: () => false, poolOn: () => true, pods: () => { throw new Error('x'); }, slotsOf: () => 8,
    waiters: () => 20, homeStats: () => home, settings: () => ({ ...M.DEFAULTS }), now: () => t });
  assert.strictEqual(broken.shouldRunLocal(trim), false);
  assert.strictEqual(broken.stats.errors, 1);

  console.log('pod-overflow tests ok');
})().catch(e => { console.error(e); process.exit(1); });
