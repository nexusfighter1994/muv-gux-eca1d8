'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const R = require(path.join(__dirname, '../node/pod-rescue.cjs'));

const on = () => ({ ...R.DEFAULTS, workloads: [...R.DEFAULTS.workloads] });
const tick = () => new Promise(r => setImmediate(r));

// A local lane that only runs work when told to; abort removes a waiter like the app's scheduler does.
function lane() {
  const waiters = [];
  const run = (jobId, l, fn, o = {}) => new Promise((resolve, reject) => {
    const w = { jobId, l, fn, o, resolve, reject };
    if (o.signal) o.signal.addEventListener('abort', () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(o.signal.reason); } }, { once: true });
    waiters.push(w);
  });
  const grant = async () => { const w = waiters.shift(); try { w.resolve(await w.fn()); } catch (e) { w.reject(e); } };
  return { run, waiters, grant };
}
function native(over = {}) {
  return { free: 0, present: true, spins: [], podFreeSlots() { return this.free; }, podPresent() { return this.present; },
    poolOn: () => true, spinup(j) { this.spins.push(j); }, ...over };
}

test('local completion resolves without the pod', async () => {
  const L = lane(), n = native(), r = R.createRescue(n, { settings: on });
  const p = r.race({ jobId: 'j', workload: 'animations', runLocal: (s, g) => L.run('j', 'frameshift', g(async () => 'local'), { signal: s }), runPod: () => 'pod' });
  await L.grant();
  assert.equal(await p, 'local');
  assert.equal(r.tick(), 0);
  assert.equal(r.stats().local, 1);
});

test('a free pod slot takes the oldest waiting render; its local wait is removed', async () => {
  const L = lane(), n = native(), r = R.createRescue(n, { settings: on });
  let podRuns = 0;
  const mk = id => r.race({ jobId: id, workload: 'animations', runLocal: (s, g) => L.run(id, 'frameshift', g(async () => 'local-' + id), { signal: s }), runPod: async () => { podRuns++; return 'pod-' + id; } });
  const a = mk('a'), b = mk('b');
  assert.equal(r.tick(), 0, 'no free slot');
  n.free = 1;
  assert.equal(r.tick(), 1);
  assert.equal(await a, 'pod-a');
  assert.equal(L.waiters.length, 1, 'a left the local queue');
  assert.equal(r.tick(), 0, 'the slot just used settles first');
  await L.grant();
  assert.equal(await b, 'local-b');
  assert.equal(podRuns, 1);
});

test('a render whose callback already started is never moved', async () => {
  const L = lane(), n = native({ free: 5 }), r = R.createRescue(n, { settings: on });
  let release;
  const p = r.race({ jobId: 'j', workload: 'animations', runLocal: (s, g) => L.run('j', 'frameshift', g(() => new Promise(res => { release = res; })), { signal: s }), runPod: () => 'pod' });
  const granting = L.grant();
  await tick();
  assert.equal(r.tick(), 0);
  release('local'); await granting;
  assert.equal(await p, 'local');
});

test('guarded callback keeps the original source and refuses to start after a move', () => {
  const fn = () => 'x';
  const state = { started: false, rescued: false };
  const g = R.guarded(fn, state);
  assert.equal(String(g), String(fn));
  state.rescued = true;
  assert.throws(() => g(), e => e.vfPodRescue === true);
});

test('no pod: one spin-up once enough renders wait, rate-limited', () => {
  let t = 0;
  const n = native({ present: false }), r = R.createRescue(n, { settings: () => ({ ...on(), spinupMinQueued: 2 }), now: () => t });
  const L = lane();
  for (const id of ['a', 'b']) r.race({ jobId: id, workload: 'animations', runLocal: (s, g) => L.run(id, 'frameshift', g(() => 1), { signal: s }), runPod: () => 2 });
  r.tick(); r.tick();
  assert.deepEqual(n.spins, ['a']);
  t += 61000; r.tick();
  assert.equal(n.spins.length, 2);
});

test('rendererLane: the local branch waits through the race and moves to the pod path when a slot frees', async () => {
  const L = lane(), n = native(), r = R.createRescue(n, { settings: on });
  let podFree = false, remote = false;
  // stand-in for the app's od: pod path if a slot is free, else local run on the given scheduler
  const od = (j, l, label, fn, { scheduler, workload }) => podFree
    ? (remote = true, Promise.resolve(scheduler.run(j, 'gpuFfmpeg', fn)).finally(() => { remote = false; }))
    : scheduler.run(j, l, fn);
  const sched = { run: (j, l, f, o) => l === 'gpuFfmpeg' ? Promise.resolve(f()).then(v => 'pod:' + v) : L.run(j, l, f, o) };
  const wrapped = R.wrapRendererLane(od, r, { isRemote: () => remote });
  const p = wrapped('j', 'frameshift', 'Custom animation', async () => 'frames', { scheduler: sched, workload: 'animations' });
  assert.equal(L.waiters.length, 1);
  podFree = true; n.free = 1;
  assert.equal(r.tick(), 1);
  assert.equal(await p, 'pod:frames');
  assert.equal(L.waiters.length, 0);
  // other workloads pass straight through
  const q = wrapped('k', 'frameshift', 'x', async () => 'c', { scheduler: sched, workload: 'compositions' });
  assert.equal(await q, 'pod:c');
});

test('scheduler wrapper moves only Home Motion native recoveries', async () => {
  const L = lane(), n = native(), r = R.createRescue(n, { settings: on });
  const sched = { run: (j, l, f, o) => L.run(j, l, f, o) };
  const dxeCalls = [];
  R.wrapRecoveryRun(sched, r, { isRemote: () => true, settings: on, dxe: (j, label, fn) => { dxeCalls.push(j); return fn(); } });
  const plain = sched.run('a', 'frameshift', async () => 'v', { homeKind: 'motion-validation' });
  const rec = sched.run('b', 'frameshift', async () => 'rendered', { homeKind: 'motion-native-recovery' });
  assert.equal(L.waiters.length, 2);
  assert.equal(r.tick(), 0, 'isRemote true at the call means nothing was raced');
  await L.grant(); await L.grant();
  assert.equal(await plain, 'v'); assert.equal(await rec, 'rendered');

  const L2 = lane(), r2 = R.createRescue(native({ free: 1 }), { settings: on });
  const s2 = { run: (j, l, f, o) => l === 'gpuFfmpeg' ? Promise.resolve(f()).then(v => 'pod:' + v) : L2.run(j, l, f, o) };
  let remote = false;
  R.wrapRecoveryRun(s2, r2, { isRemote: () => remote, settings: on, dxe: async (j, label, fn) => { remote = true; try { return await fn(); } finally { remote = false; } } });
  const p = s2.run('c', 'frameshift', async () => 'frames', { homeKind: 'motion-native-recovery' });
  assert.equal(L2.waiters.length, 1);
  assert.equal(r2.tick(), 1);
  assert.equal(await p, 'pod:frames');
  assert.equal(L2.waiters.length, 0);
});

test('settings: defaults, off switch, bounds', () => {
  const s = R.createSettingsReader('/x', () => '{"enabled":false,"tickMs":5,"workloads":["animations"]}', () => 0);
  const v = s();
  assert.equal(v.enabled, false); assert.equal(v.tickMs, R.DEFAULTS.tickMs); assert.deepEqual(v.workloads, ['animations']);
  assert.equal(R.createSettingsReader('/missing', () => { throw Error('no'); }, () => 0)().enabled, true);
});

test('priority entries (Home Motion recoveries) take a free pod slot before older plain waits', async () => {
  const L = lane(), n = native(), r = R.createRescue(n, { settings: on });
  let t = 0;
  const r2 = R.createRescue(n, { settings: on, now: () => t });
  const mk = (id, priority) => r2.race({ jobId: id, workload: 'animations', priority, runLocal: (s, g) => L.run(id, 'frameshift', g(async () => 'local-' + id), { signal: s }), runPod: async () => 'pod-' + id });
  const old = mk('old', 0); t = 1000; const rec = mk('rec', 1);
  n.free = 1;
  assert.equal(r2.tick(), 1);
  assert.equal(await rec, 'pod-rec');
  await L.grant();
  assert.equal(await old, 'local-old');
  assert.equal(r.stats().registered, 0);
});

test('recoveries: at most localRecoveries take the local path, the rest only wait for a pod and never start locally', async () => {
  const L = lane(), n = native(), r = R.createRescue(n, { settings: on });
  let remote = false;
  const s = { run: (j, l, f, o) => l === 'gpuFfmpeg' ? Promise.resolve(f()).then(v => 'pod:' + v) : L.run(j, l, f, o) };
  R.wrapRecoveryRun(s, r, { isRemote: () => remote, settings: () => ({ ...on(), localRecoveries: 2 }),
    dxe: async (j, label, fn) => { remote = true; try { return await fn(); } finally { remote = false; } } });
  const started = [];
  const mk = id => s.run(id, 'frameshift', async () => { started.push(id); return 'frames-' + id; }, { homeKind: 'motion-native-recovery' });
  const ps = ['a', 'b', 'c', 'd', 'e'].map(mk);
  assert.equal(L.waiters.length, 2, 'only two are queued on the local lane');
  assert.deepEqual(s.run.localStats(), { active: 2, podOnly: 3 });
  // the local lane runs its two; the pod-only ones did not start
  await L.grant(); await L.grant();
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(await ps[0], 'frames-a'); assert.equal(await ps[1], 'frames-b');
  await tick();
  assert.equal(s.run.localStats().active, 0);
  // a pod slot frees: one waiting recovery goes there
  n.free = 1;
  assert.equal(r.tick(), 1);
  assert.equal(await ps[2], 'pod:frames-c');
  // the caller gives up (scope ended): the pod-only wait rejects, nothing ran
  const ac = new AbortController();
  const gone = s.run('z', 'frameshift', async () => { started.push('z'); return 1; }, { homeKind: 'motion-native-recovery', signal: ac.signal });
  ac.abort(new Error('Motion scope ended'));
  await assert.rejects(gone, /Motion scope ended/);
  assert.ok(!started.includes('z'));
});

test('free pod slots follow the app job priority (finish-first) before age', async () => {
  const L = lane(); let t = 0;
  const n = native({ jobPriorities: () => new Map([['old-video', '4|03|x'], ['new-video', '4|07|y']]) });
  const r = R.createRescue(n, { settings: on, now: () => t });
  const mk = (id, job) => r.race({ jobId: job, workload: 'animations', runLocal: (s, g) => L.run(id, 'frameshift', g(async () => 'local-' + id), { signal: s }), runPod: async () => 'pod-' + id });
  const fresh = mk('n1', 'new-video'); t = 5000; const late = mk('o1', 'old-video'); const unknown = mk('u1', 'other');
  n.free = 1;
  assert.equal(r.tick(), 1);
  assert.equal(await late, 'pod-o1', 'the nearly finished video goes first although it registered later');
  t = 20000; n.free = 1; assert.equal(r.tick(), 1);
  assert.equal(await fresh, 'pod-n1', 'known priority before unknown');
  await L.grant(); assert.equal(await unknown, 'local-u1');
});
