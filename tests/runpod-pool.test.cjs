'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../node/runpod-pool.cjs');

const cfgFile = (obj) => { const f = path.join(os.tmpdir(), `vf-rp-${process.pid}-${Math.random()}.json`); if (obj) fs.writeFileSync(f, JSON.stringify(obj)); return f; };

test('v1 create body maps to v2 with pod env and min vCPU', () => {
  const b = P.v2CreateBody({ name: 'n', cloudType: 'COMMUNITY', gpuTypeIds: ['NVIDIA RTX A5000'], gpuTypePriority: 'custom', minVCPUPerGPU: 4,
    minRAMPerGPU: 16, containerDiskInGb: 50, imageName: 'img:tag', ports: ['8000/http'], env: { A: '1' } }, P.DEFAULTS);
  assert.deepStrictEqual(b, { name: 'n', image: 'img:tag', cloud: 'COMMUNITY', gpu: { id: 'NVIDIA RTX A5000', count: 1, minRamPerGpu: 16, minVcpuCountPerGpu: 4 },
    disk: 50, ports: ['8000/http'], env: { A: '1', FFLOW_GPU_SLOT_CPU_CAP: 'false' } });
});

test('kt wrapper translates v1 pod calls to v2 and maps responses', async () => {
  const calls = [];
  const orig = async (url, opts) => { calls.push([url, opts.method || 'GET']);
    if (url === P.V2 && opts.method === 'POST') return { id: 'p1', status: 'PROVISIONING', cost: 0.16, gpu: { id: 'G' }, image: 'img' };
    if (url === `${P.V2}/p1`) return { id: 'p1', status: 'RUNNING', cost: 0.16, gpu: { id: 'G' } };
    if (url === `${P.V2}/gone`) return { id: 'gone', status: 'TERMINATED' };
    return null; };
  const stats = { v2create: 0, v2get: 0, v2delete: 0, forcedReady: 0 };
  const kt = P.wrapKt(orig, () => P.DEFAULTS, stats);
  const c = await kt(P.V1, { method: 'POST', json: { name: 'n', gpuTypeIds: ['G'], imageName: 'img' } });
  assert.strictEqual(c.id, 'p1'); assert.strictEqual(c.costPerHr, 0.16); assert.strictEqual(c.machine.gpuTypeId, 'G');
  const g = await kt(`${P.V1}/p1`, {}); assert.strictEqual(g.desiredStatus, 'RUNNING');
  await assert.rejects(kt(`${P.V1}/gone`, {}), e => e.detail.status === 404);
  await kt(`${P.V1}/p1`, { method: 'DELETE' });
  assert.deepStrictEqual(calls.map(c => c[0]), [P.V2, `${P.V2}/p1`, `${P.V2}/gone`, `${P.V2}/p1`]);
  assert.deepStrictEqual([stats.v2create, stats.v2get, stats.v2delete], [1, 2, 1]);
});

test('kt wrapper forces ready only for a real NVENC gpu profile', async () => {
  const stats = { forcedReady: 0 };
  const kt = P.wrapKt(async () => ({ data: { ffmpeg: { gpu: { profile: 'gpu', h264_nvenc: true, gpu_name: 'X', ready: false } } } }), () => P.DEFAULTS, stats);
  const r = await kt('https://abc-8000.proxy.runpod.net/v1/health', {});
  assert.strictEqual(r.data.ffmpeg.gpu.ready, true); assert.strictEqual(stats.forcedReady, 1);
  const kt2 = P.wrapKt(async () => ({ data: { ffmpeg: { gpu: { profile: 'gpu', h264_nvenc: false, gpu_name: 'X', ready: false } } } }), () => P.DEFAULTS, stats);
  assert.strictEqual((await kt2('https://abc-8000.proxy.runpod.net/v1/health', {})).data.ffmpeg.gpu.ready, false);
});

test('gpu list filtered by min VRAM', async () => {
  const gl = P.wrapGpuList(async () => [{ memoryInGb: 8 }, { memoryInGb: 16 }, { memoryInGb: 24 }], () => ({ ...P.DEFAULTS, gpuPick: 'cheapest' }));
  assert.deepStrictEqual((await gl()).map(x => x.memoryInGb), [16, 24]);
});

// 2026-11-21: strongest available GPU within the cap; the stock list arrives cheapest first.
const offer = (id, cloudType, price, memoryInGb, displayName = id) => ({ id, displayName, cloudType, price, memoryInGb });
const stockList = () => [
  offer('NVIDIA RTX 2000 Ada Generation', 'SECURE', 0.24, 16),
  offer('NVIDIA GeForce RTX 3090', 'COMMUNITY', 0.22, 24), offer('NVIDIA GeForce RTX 3090', 'SECURE', 0.43, 24),
  offer('NVIDIA GeForce RTX 4090', 'COMMUNITY', 0.34, 24), offer('NVIDIA GeForce RTX 4090', 'SECURE', 0.69, 24),
  offer('NVIDIA RTX A6000', 'COMMUNITY', 0.33, 48), offer('NVIDIA RTX A6000', 'SECURE', 0.49, 48),
  offer('NVIDIA GeForce RTX 5080', 'COMMUNITY', 0.39, 16), offer('NVIDIA GeForce RTX 5090', 'COMMUNITY', 0.69, 32),
  offer('NVIDIA L40S', 'COMMUNITY', 0.79, 48), offer('NVIDIA RTX A4000', 'COMMUNITY', 0.17, 16),
].sort((a, b) => a.price - b.price);

test('strongest first: known strength table, cheaper offer of a type first, Blackwell left out', async () => {
  const gl = P.wrapGpuList(async () => stockList(), () => ({ ...P.DEFAULTS, gpuPick: 'strongest', preferCloud: '' }));
  const got = (await gl()).map(x => `${x.id.replace('NVIDIA ', '').replace('GeForce ', '')} ${x.cloudType[0]} ${x.price}`);
  assert.deepStrictEqual(got, ['L40S C 0.79', 'RTX 4090 C 0.34', 'RTX 4090 S 0.69', 'RTX A6000 C 0.33', 'RTX A6000 S 0.49',
    'RTX 3090 C 0.22', 'RTX 3090 S 0.43', 'RTX A4000 C 0.17', 'RTX 2000 Ada Generation S 0.24']);
});

test('the live list of 21.11. 08:15Z: L40 first, a pricey L4 below A40; unknown types ranked by price', () => {
  const live = [offer('NVIDIA GeForce RTX 3090', 'COMMUNITY', 0.22, 24), offer('NVIDIA RTX 2000 Ada Generation', 'SECURE', 0.24, 16, 'RTX 2000 Ada'),
    offer('NVIDIA RTX A4000', 'SECURE', 0.25, 16, 'RTX A4000'), offer('NVIDIA A40', 'SECURE', 0.59, 48, 'A40'),
    offer('NVIDIA L4', 'SECURE', 0.69, 24, 'L4'), offer('NVIDIA RTX A6000', 'SECURE', 0.69, 48, 'RTX A6000'), offer('NVIDIA L40', 'COMMUNITY', 0.69, 48, 'L40')];
  assert.deepStrictEqual(P.orderOffers(live, { ...P.DEFAULTS, gpuPick: 'strongest', preferCloud: '' }).map(x => x.displayName),
    ['L40', 'RTX A6000', 'A40', 'NVIDIA GeForce RTX 3090', 'L4', 'RTX A4000', 'RTX 2000 Ada']);
  // with the default Community preference the two Community offers lead
  assert.deepStrictEqual(P.orderOffers(live, { ...P.DEFAULTS, gpuPick: 'strongest' }).map(x => x.displayName).slice(0, 2), ['L40', 'NVIDIA GeForce RTX 3090']);  // L4/A4000 same tier: more VRAM first
  assert.strictEqual(P.gpuStrength(offer('NVIDIA L40S', 'SECURE', 0.86, 48), 0.86), 100);
  assert.strictEqual(P.gpuStrength(offer('NVIDIA L40', 'SECURE', 0.69, 48), 0.69), 95);
  assert.strictEqual(P.gpuStrength(offer('NVIDIA Hypothetical X', 'SECURE', 0.55, 48), 0.55), 55);
});

test('excludeGpus and gpuPick are knobs; a broken pattern excludes nothing', () => {
  const ids = cfg => P.orderOffers(stockList(), { ...P.DEFAULTS, ...cfg }).map(x => x.id);
  assert.ok(ids({ excludeGpus: '' }).includes('NVIDIA GeForce RTX 5090'));
  assert.ok(ids({ excludeGpus: '(' }).includes('NVIDIA GeForce RTX 5080'));
  assert.ok(!ids({}).some(id => /RTX 50/.test(id)));
  assert.deepStrictEqual(ids({ gpuPick: 'cheapest', excludeGpus: '' }), stockList().map(x => x.id), 'stock order kept');
  assert.ok(!ids({ minVramGb: 24 }).includes('NVIDIA RTX A4000'));
  assert.deepStrictEqual(P.orderOffers(null, P.DEFAULTS), []);
  assert.deepStrictEqual(P.orderOffers([offer('X', 'SECURE', NaN, 24), null, offer('Y', 'SECURE', 0.3, 24)], P.DEFAULTS).map(x => x.id), ['Y', 'X']);
});

test('pool switched off in the knob: the stock list passes unchanged', async () => {
  const list = stockList();
  const gl = P.wrapGpuList(async () => list, () => ({ ...P.DEFAULTS, enabled: false }));
  assert.strictEqual(await gl(), list);
});

function fakeNative({ ready = [], free = null, waiters = 0, spinups = 0, booting = false } = {}) {
  return { pool: () => ({ waiters: new Array(waiters), spinups: new Set(new Array(spinups).fill(0).map((_, i) => i)), pods: booting ? [{ state: 'booting' }] : [] }),
    readyPods: () => ready, podUsable: () => true, freePod: () => free };
}

test('acquire: no pod -> local lease + one spin-up trigger', async () => {
  const stats = { overflowLocal: 0, podQueued: 0, noPodLocal: 0, spinupTriggers: 0, deterministicFailures: 0 };
  let origCalls = 0; const orig = async () => { origCalls++; return { release() {} }; };
  let t = 1e6; const acq = P.wrapAcquire(orig, fakeNative(), () => P.DEFAULTS, stats, () => t);
  const a = await acq({ jobId: 'j' }); assert.strictEqual(a.capabilities.fflow, false);
  await acq({ jobId: 'j' }); await new Promise(r => setImmediate(r));
  assert.strictEqual(stats.noPodLocal, 2); assert.strictEqual(stats.spinupTriggers, 1); assert.strictEqual(origCalls, 1);
  t += 181e3; await acq({ jobId: 'j' }); assert.strictEqual(stats.spinupTriggers, 2);
});

test('acquire: pod full -> bounded wait, then local', async () => {
  const stats = { overflowLocal: 0, podQueued: 0, noPodLocal: 0, spinupTriggers: 0, deterministicFailures: 0 };
  const orig = async () => ({ reportFailure: async () => 'counted', release() {} });
  const acqQ = P.wrapAcquire(orig, fakeNative({ ready: [{}], free: null, waiters: 5 }), () => P.DEFAULTS, stats);
  const l = await acqQ({}); assert.strictEqual(stats.podQueued, 1); assert.ok(!l.vfLocal);
  assert.strictEqual(await l.reportFailure(new Error('pollJob: FFMPEG_ERROR: Encoder error')), undefined);
  assert.strictEqual(stats.deterministicFailures, 1);
  assert.strictEqual(await l.reportFailure(new Error('fetch failed')), undefined, 'transient since 21.11., not counted against the pod');
  assert.strictEqual(await l.reportFailure(new Error('worker crashed')), 'counted');
  const acqFull = P.wrapAcquire(orig, fakeNative({ ready: [{}], free: null, waiters: 20 }), () => P.DEFAULTS, stats);
  assert.ok((await acqFull({})).vfLocal); assert.strictEqual(stats.overflowLocal, 1);
});

test('controller: hysteresis 800 / 2000 with minimum on-time', () => {
  let enabled = false; let q = 1000; let t = 0; const saved = [];
  const native = { lane: k => ({ waiters: new Array(k === 'render' ? 0 : q) }), settings: () => ({ gpuFfmpegEnabled: enabled }),
    saveSettings: p => { saved.push(p); if ('gpuFfmpegEnabled' in p) enabled = p.gpuFfmpegEnabled; }, pool: () => ({ pods: [] }) };
  const stats = { switchedOn: 0, switchedOff: 0 };
  const cfg = { ...P.DEFAULTS, controller: { ...P.DEFAULTS.controller, minOnMinutes: 15 } };
  const c = P.createController(native, () => cfg, stats, () => {}, () => t);
  assert.strictEqual(c.tick(), 'idle');
  q = 2000; assert.strictEqual(c.tick(), 'switched-on'); assert.strictEqual(enabled, true);
  assert.deepStrictEqual(saved[0].workloads, { compositions: false, brollAnalysis: true, siglip: false, animations: true, infographics: false });
  q = 500; t += 10 * 60e3; assert.strictEqual(c.tick(), 'on');
  t += 6 * 60e3; assert.strictEqual(c.tick(), 'switched-off'); assert.strictEqual(enabled, false);
  q = 1999; assert.strictEqual(c.tick(), 'idle');
});

test('controller: render queue also switches on, off only when both queues are low', () => {
  let enabled = false; let q = 100; let rq = 700; let t = 0;
  const native = { lane: k => ({ waiters: new Array(k === 'render' ? rq : q) }), settings: () => ({ gpuFfmpegEnabled: enabled }),
    saveSettings: p => { if ('gpuFfmpegEnabled' in p) enabled = p.gpuFfmpegEnabled; }, pool: () => ({ pods: [] }) };
  const withRender = { ...P.DEFAULTS, controller: { ...P.DEFAULTS.controller, renderOnAbove: 600, renderOffBelow: 200 } };
  const c = P.createController(native, () => withRender, {}, () => {}, () => t);
  assert.strictEqual(c.tick(), 'switched-on');
  rq = 300; assert.strictEqual(c.tick(), 'on');          // ffmpeg low but render still >= 200
  rq = 150; assert.strictEqual(c.tick(), 'switched-off');
  rq = 599; assert.strictEqual(c.tick(), 'idle');
  const cfgOld = { ...P.DEFAULTS, controller: { ...P.DEFAULTS.controller, enabled: false, combined: true, renderOnAbove: 600 } };
  const c2 = P.createController(native, () => cfgOld, {}, () => {}, () => t);
  rq = 600; assert.strictEqual(c2.tick(), 'switched-on'); // combined keeps v2 active when enabled:false silences v1
});

test('acquire: a pod that mostly fails with encoder errors is escalated to the native failure path', async () => {
  const stats = { overflowLocal: 0, podQueued: 0, noPodLocal: 0, spinupTriggers: 0, deterministicFailures: 0 };
  let counted = 0;
  const orig = async () => ({ podId: 'bad', reportFailure: async () => { counted++; return 'counted'; }, reportSuccess() {}, release() {} });
  const acq = P.wrapAcquire(orig, fakeNative({ ready: [{}], free: {}, waiters: 0 }), () => P.DEFAULTS, stats);
  const enc = new Error('pollJob: FFMPEG_ERROR: Failed to trim video: Encoder error - FFmpeg could not encode one or more frames');
  for (let i = 0; i < 9; i++) assert.strictEqual(await (await acq({})).reportFailure(enc), undefined);
  assert.strictEqual(counted, 0);
  assert.strictEqual(await (await acq({})).reportFailure(enc), 'counted');   // 10th failure, 100 % failing
  assert.strictEqual(stats.brokenPodEscalations, 1);
  // a healthy pod with an occasional bad source keeps the filter
  const orig2 = async () => ({ podId: 'good', reportFailure: async () => 'counted', reportSuccess() {}, release() {} });
  const acq2 = P.wrapAcquire(orig2, fakeNative({ ready: [{}], free: {}, waiters: 0 }), () => P.DEFAULTS, stats);
  for (let i = 0; i < 25; i++) (await acq2({})).reportSuccess();
  for (let i = 0; i < 4; i++) assert.strictEqual(await (await acq2({})).reportFailure(enc), undefined);
});

test('cost guard terminates an idle pod only while the pool is off', () => {
  let t = 10 * 60e3; const killed = [];
  const pods = [{ id: 'a', state: 'ready', inflight: 0, idleSinceMs: 0 }, { id: 'b', state: 'ready', inflight: 2, idleSinceMs: 0 }, { id: 'c', state: 'ready', inflight: 0, idleSinceMs: 9 * 60e3 }];
  let enabled = false;
  const native = { lane: () => ({ waiters: [] }), settings: () => ({ gpuFfmpegEnabled: enabled }), saveSettings: () => {}, pool: () => ({ pods }), terminatePod: p => { killed.push(p.id); } };
  const stats = {};
  const c = P.createController(native, () => P.DEFAULTS, stats, () => {}, () => t);
  c.tick(); assert.deepStrictEqual(killed, ['a']); assert.strictEqual(stats.guardTerminations, 1);
  enabled = true; killed.length = 0; c.tick(); assert.deepStrictEqual(killed, []);
});

test('config file overrides and controller off switch', () => {
  const f = cfgFile({ controller: { enabled: false, combined: false, offBelow: 100 } });
  const read = P.createConfigReader(f);
  assert.strictEqual(read().controller.enabled, false); assert.strictEqual(read().controller.offBelow, 100); assert.strictEqual(read().controller.onAbove, 2000);
  const c = P.createController({ lane: () => ({ waiters: [] }), settings: () => ({}) }, read, {}, () => {});
  assert.strictEqual(c.tick(), 'off');
  fs.unlinkSync(f);
});

test('controller: workloads edited while the pool is on are synced once, trigger stays ffmpeg', () => {
  let s = { gpuFfmpegEnabled: true, workloads: { brollAnalysis: true } }; const saved = [];
  const native = { lane: k => ({ waiters: new Array(k === 'render' ? 200 : 1200) }), settings: () => s,
    saveSettings: p => { saved.push(p); s = { ...s, ...p }; }, pool: () => ({ pods: [] }) };
  const stats = {};
  const c = P.createController(native, () => ({ ...P.DEFAULTS, podScaling: false }), stats, () => {}, () => 0);
  assert.strictEqual(c.tick(), 'on');
  assert.deepStrictEqual(saved, [{ workloads: { compositions: false, brollAnalysis: true, siglip: false, animations: true, infographics: false } }]);
  assert.strictEqual(c.tick(), 'on'); assert.strictEqual(saved.length, 1); assert.strictEqual(stats.workloadSyncs, 1);
  s = { gpuFfmpegEnabled: false }; saved.length = 0;
  const renderOff = { ...P.DEFAULTS, controller: { ...P.DEFAULTS.controller, renderOnAbove: 0 } };
  const c2 = P.createController({ ...native, lane: k => ({ waiters: new Array(k === 'render' ? 5000 : 1999) }) }, () => renderOff, {}, () => {}, () => 0);
  assert.strictEqual(c2.tick(), 'idle'); assert.deepStrictEqual(saved, []);   // render trigger switched off: 5000 alone never switches on
});

test('controller: render trigger set to 0 -> render queue neither switches on nor keeps the pool on', () => {
  let enabled = true; const q = 100, rq = 900;
  const native = { lane: k => ({ waiters: new Array(k === 'render' ? rq : q) }), settings: () => ({ gpuFfmpegEnabled: enabled }),
    saveSettings: p => { if ('gpuFfmpegEnabled' in p) enabled = p.gpuFfmpegEnabled; }, pool: () => ({ pods: [] }) };
  const renderOff = { ...P.DEFAULTS, controller: { ...P.DEFAULTS.controller, renderOnAbove: 0 } };
  const c = P.createController(native, () => renderOff, {}, () => {}, () => 0);
  assert.strictEqual(c.tick(), 'switched-off');   // ffmpeg 100 < 800, render ignored
  assert.strictEqual(c.tick(), 'idle');           // render 900 does not switch on
});

test('controller defaults (owner 21.11.): motion graphics >= 900 switches on, stays on until <= 300 and ffmpeg < 800', () => {
  let enabled = false; let q = 0; let rq = 899; const log = [];
  const native = { lane: k => ({ waiters: new Array(k === 'render' ? rq : q) }), settings: () => ({ gpuFfmpegEnabled: enabled }),
    saveSettings: p => { if ('gpuFfmpegEnabled' in p) enabled = p.gpuFfmpegEnabled; }, pool: () => ({ pods: [] }) };
  const stats = { switchedOn: 0, switchedOff: 0 };
  const c = P.createController(native, () => P.DEFAULTS, stats, m => log.push(m), () => 0);
  assert.strictEqual(c.tick(), 'idle');
  rq = 900; assert.strictEqual(c.tick(), 'switched-on');
  rq = 301; assert.strictEqual(c.tick(), 'on');
  rq = 300; q = 900; assert.strictEqual(c.tick(), 'on', 'ffmpeg queue still busy');
  q = 799; assert.strictEqual(c.tick(), 'switched-off');
  assert.strictEqual(stats.switchedOn, 1); assert.strictEqual(stats.switchedOff, 1);
  assert.match(log.join('\n'), /render queue 900 \(>= 900\?\)/); assert.match(log.join('\n'), /render queue 300 <= 300/);
  rq = 899; assert.strictEqual(c.tick(), 'idle');
  q = 2000; rq = 0; assert.strictEqual(c.tick(), 'switched-on', 'the 2000 ffmpeg rule is unchanged');
});

test('brollAnalysis goes to the pod only during an ffmpeg jam (on >= 2000, kept until < 800); animations stay', () => {
  let s = { gpuFfmpegEnabled: false }; let q = 100; let rq = 1000; const saved = [];
  const native = { lane: k => ({ waiters: new Array(k === 'render' ? rq : q) }), settings: () => s,
    saveSettings: p => { saved.push(p); s = { ...s, ...p }; }, pool: () => ({ pods: [] }) };
  const c = P.createController(native, () => P.DEFAULTS, {}, () => {}, () => 0);
  assert.strictEqual(c.tick(), 'switched-on');                     // motion graphics 1000 >= 900
  assert.strictEqual(s.workloads.brollAnalysis, false); assert.strictEqual(s.workloads.animations, true);
  q = 1999; c.tick(); assert.strictEqual(s.workloads.brollAnalysis, false);
  q = 2000; c.tick(); assert.strictEqual(s.workloads.brollAnalysis, false, 'motion graphics jam (1000 > 300) keeps trims off the pod');
  rq = 300; q = 2000; c.tick(); assert.strictEqual(s.workloads.brollAnalysis, true);
  q = 800; c.tick(); assert.strictEqual(s.workloads.brollAnalysis, true, 'kept above offBelow');
  q = 799; assert.strictEqual(c.tick(), 'switched-off', 'ffmpeg < 800 and render <= 300: the whole pool goes off');
  assert.strictEqual(s.workloads.animations, true);
  const cfg = { ...P.DEFAULTS, controller: { ...P.DEFAULTS.controller, brollAboveFfmpeg: 1200 } };
  assert.strictEqual(P.wantedWorkloads(cfg.controller, 1200).brollAnalysis, true);
  assert.strictEqual(P.wantedWorkloads(cfg.controller, 1199).brollAnalysis, false);
});

// 2026-11-21: pod concurrency follows its vCPU (animations render on the pod CPU).
test('v1Shape records the vCPU count of a v2 pod record', () => {
  const r = P.v1Shape({ id: 'pod-cpu-1', status: 'RUNNING', cost: 0.69, gpu: { id: 'NVIDIA L40', count: 1, vcpuCount: 24 } });
  assert.strictEqual(r.vcpuCount, 24); assert.strictEqual(P.POD_CPU.get('pod-cpu-1'), 24);
  assert.strictEqual(P.v1Shape({ id: 'pod-cpu-2', status: 'RUNNING', gpu: { id: 'X' } }).vcpuCount, undefined);
  assert.strictEqual(P.POD_CPU.has('pod-cpu-2'), false);
});

test('capPodSlots: vCPU/2, fallback while unknown, never raises a lower value, 0 switches it off', () => {
  const cpu = new Map([['a', 24], ['b', 9]]);
  const pods = [{ id: 'a', safeConcurrency: 22 }, { id: 'b' }, { id: 'c', safeConcurrency: 22 }, { id: 'd', safeConcurrency: 4 }, null];
  assert.strictEqual(P.capPodSlots(pods, P.DEFAULTS, cpu), 3);
  assert.deepStrictEqual(pods.slice(0, 4).map(p => p.safeConcurrency), [12, 4, 12, 4]);
  assert.strictEqual(P.capPodSlots(pods, P.DEFAULTS, cpu), 0, 'idempotent');
  const off = [{ id: 'a', safeConcurrency: 22 }];
  assert.strictEqual(P.capPodSlots(off, { ...P.DEFAULTS, cpuPerPodSlot: 0 }, cpu), 0); assert.strictEqual(off[0].safeConcurrency, 22);
  const noFallback = [{ id: 'z', safeConcurrency: 22 }];
  assert.strictEqual(P.capPodSlots(noFallback, { ...P.DEFAULTS, podMaxConcurrency: 0 }, cpu), 0);
  assert.strictEqual(P.capPodSlots([{ id: 'one' }], P.DEFAULTS, new Map([['one', 1]])), 1);
});

test('controller tick caps the slots of live pods and logs it once', () => {
  const pods = [{ id: 'pod-cpu-1', state: 'ready', inflight: 5, safeConcurrency: 22 }];
  const log = []; const stats = {};
  const native = { lane: () => ({ waiters: [] }), settings: () => ({ gpuFfmpegEnabled: true }), saveSettings: () => {}, pool: () => ({ pods }) };
  const c = P.createController(native, () => ({ ...P.DEFAULTS, controller: { ...P.DEFAULTS.controller, renderOnAbove: 0 } }), stats, m => log.push(m), () => 0);
  c.tick(); c.tick();
  assert.strictEqual(pods[0].safeConcurrency, 12); assert.strictEqual(stats.podSlotCaps, 1);
  assert.strictEqual(log.filter(m => /slots capped/.test(m)).length, 1);
});

test('capPodSlots leaves a pod alone while its render service is off (trims only)', () => {
  const cpu = new Map([['r', 24]]);
  const pods = [{ id: 'r', safeConcurrency: 22, capabilities: { fflow: true, render: false } }, { id: 'r', safeConcurrency: 22, capabilities: { fflow: true, render: true } }];
  assert.strictEqual(P.capPodSlots(pods, P.DEFAULTS, cpu), 1);
  assert.deepStrictEqual(pods.map(p => p.safeConcurrency), [22, 12]);
});

test('applyPatches sets the pod op timeout (default 30 min, knob opTimeoutMin, at least 15)', () => {
  const timing = { bootTimeoutMs: 0, opTimeoutMs: 15 * 60e3 };
  const kt = async () => ({}), gl = async () => [];
  const mk = obj => {
    const n = { ready: () => true, overrideBox: () => ({}), timing: () => timing, setOfferCount() {}, getKt: () => kt, setKt() {},
      getGpuList: () => gl, setGpuList() {}, api: () => ({ acquire: Object.assign(async () => null, { __vfOrig: true }) }) };
    return P.createRunpodPool(n, { file: cfgFile(obj), log: () => {}, setIntervalImpl: () => null });
  };
  mk({ enabled: true }).applyPatches();
  assert.strictEqual(timing.opTimeoutMs, 30 * 60e3);
  mk({ enabled: true, opTimeoutMin: 45 }).applyPatches();
  assert.strictEqual(timing.opTimeoutMs, 45 * 60e3);
  mk({ enabled: true, opTimeoutMin: 5 }).applyPatches();
  assert.strictEqual(timing.opTimeoutMs, 15 * 60e3);
});

test('render switched off by the app is re-probed after renderRetryMin; Community offers rank first', () => {
  const seen = new Map(); const probed = [];
  const pod = { id: 'a', state: 'ready', disabledServices: new Set(['render']), capabilities: { render: false } };
  const cfg = { renderRetryMin: 3 };
  assert.strictEqual(P.reenableRender([pod], cfg, p => probed.push(p.id), seen, 0), 0, 'first sighting starts the clock');
  assert.strictEqual(P.reenableRender([pod], cfg, p => probed.push(p.id), seen, 120000), 0);
  assert.strictEqual(P.reenableRender([pod], cfg, p => probed.push(p.id), seen, 180000), 1);
  assert.strictEqual(pod.disabledServices.has('render'), false);
  assert.strictEqual(P.reenableRender([pod], { renderRetryMin: 0 }, () => {}, new Map(), 0), 0, '0 = off');
  assert.strictEqual(P.DEFAULTS.renderRetryMin, 3); assert.strictEqual(P.DEFAULTS.bootTimeoutMin, 30);
  const list = [offer('NVIDIA L40S', 'SECURE', 0.79, 48), offer('NVIDIA L40', 'COMMUNITY', 0.69, 48), offer('NVIDIA RTX 4000 Ada Generation', 'COMMUNITY', 0.2, 20)];
  const ids = P.orderOffers(list, { ...P.DEFAULTS, gpuPick: 'strongest', minVramGb: 16 }).map(x => `${x.id}/${x.cloudType}`);
  assert.deepStrictEqual(ids.slice(0, 2), ['NVIDIA L40/COMMUNITY', 'NVIDIA RTX 4000 Ada Generation/COMMUNITY']);
  assert.strictEqual(P.orderOffers(list, { ...P.DEFAULTS, gpuPick: 'strongest', minVramGb: 16, preferCloud: '' })[0].id, 'NVIDIA L40S');
});

// 21.11. 13:15Z price-performance and budget planning
const memLearn = (types = {}) => ({ get: (t, c) => types[`${t}|${c}`] || null });
test('value ranking: work per dollar from learned vCPU and boot, VRAM slot cap, Community boot bonus', () => {
  const cfg = { ...P.DEFAULTS, minVcpuPerGpu: 16, cpuPerPodSlot: 2, podMaxConcurrency: 12 };
  const learn = memLearn({ 'NVIDIA L40|COMMUNITY': { vcpu: 24, bootMin: 6 }, 'NVIDIA L4|SECURE': { vcpu: 16, bootMin: 22 } });
  const offers = [offer('NVIDIA L40', 'COMMUNITY', 0.69, 48), offer('NVIDIA L4', 'SECURE', 0.69, 24), offer('NVIDIA RTX A5000', 'SECURE', 0.27, 24),
    offer('NVIDIA RTX A4000', 'SECURE', 0.17, 16)];
  const v = Object.fromEntries(offers.map(x => [x.id, P.offerValue(x, cfg, learn)]));
  assert.ok(Math.abs(v['NVIDIA L40'] - 12 * (1 - 6 / 120) / 0.69) < 1e-9, 'L40: 24 vCPU -> 12 slots');
  assert.ok(Math.abs(v['NVIDIA RTX A4000'] - 6 * (1 - 24 / 120) / 0.17) < 1e-9, '16 GB -> 6 VRAM slots, Secure boot default 24');
  assert.deepStrictEqual(P.orderOffers(offers, cfg, learn).map(x => x.id), ['NVIDIA RTX A4000', 'NVIDIA RTX A5000', 'NVIDIA L40', 'NVIDIA L4']);
});

test('learn store: one record per ready pod, averages vCPU and boot minutes, survives a reload', () => {
  const file = cfgFile();
  const L = P.createLearnStore(file);
  const pod = (id, v, bootMin) => ({ id, gpuType: 'NVIDIA L40', cloudType: 'COMMUNITY', createdAt: '2026-11-21T10:00:00Z', readyAt: new Date(Date.parse('2026-11-21T10:00:00Z') + bootMin * 60000).toISOString(), v });
  const a = pod('a', 24, 6), b = pod('b', 16, 10);
  assert.strictEqual(L.record(a, 24), true); assert.strictEqual(L.record(a, 24), false, 'once per pod');
  L.record(b, 16);
  assert.deepStrictEqual({ v: L.get('NVIDIA L40', 'COMMUNITY').vcpu, b: L.get('NVIDIA L40', 'COMMUNITY').bootMin }, { v: 20, b: 8 });
  assert.strictEqual(P.createLearnStore(file).get('NVIDIA L40', 'COMMUNITY').n, 2);
  fs.unlinkSync(file);
});

test('planPods: scale up within budget, replace a poor-value pod, drain spare pods after scaleDownMin', () => {
  const cfg = { ...P.DEFAULTS, maxHourlySpend: 2.4, maxPods: 6, scaleUpQueued: 8, replaceRatio: 0.6, scaleDownMin: 5, minVcpuPerGpu: 16 };
  const cpu = new Map([['l40', 24], ['l4', 16], ['rtx', 18]]);
  const learn = memLearn();
  const pod = (id, gpuType, cost, vram, extra = {}) => ({ id, gpuType, costPerHr: cost, vramGb: vram, state: 'ready', inflight: 0, image: 'img', createdAt: '2026-11-21T10:00:00Z', capabilities: { render: true }, ...extra });
  const a5000 = offer('NVIDIA RTX A5000', 'SECURE', 0.27, 24);
  const pods = [pod('l40', 'NVIDIA L40', 0.69, 48, { inflight: 12, safeConcurrency: 12 }), pod('rtx', 'NVIDIA RTX 4000 Ada Generation', 0.28, 20, { inflight: 8, safeConcurrency: 8 }),
    pod('l4', 'NVIDIA L4', 0.69, 24, { inflight: 8, safeConcurrency: 8 })];
  const st = {};
  // 400 waiting, spend 1.66 + 0.27 <= 2.4, 3 < 6 pods -> scale up first
  let d = P.planPods({ pods, waiting: 400, offers: [a5000], now: 0, cpu, learn }, cfg, st);
  assert.strictEqual(d.spawn, true); assert.match(d.reason, /scale up/);
  // budget full for one more: replace the L4 (8/0.69 = 11.6 < 0.6 * 23.7)
  const T0 = Date.parse('2026-11-21T10:30:00Z');
  d = P.planPods({ pods, waiting: 400, offers: [a5000], now: T0, cpu, learn }, { ...cfg, maxHourlySpend: 1.7 }, {});
  assert.strictEqual(d.spawn, false); assert.strictEqual(d.drain, 'l4'); assert.match(d.reason, /drain first/);
  // budget with room for both, but already at maxPods: start first, drain later
  d = P.planPods({ pods, waiting: 400, offers: [a5000], now: T0, cpu, learn }, { ...cfg, maxHourlySpend: 2.4, maxPods: 3, scaleUpQueued: 9999 }, {});
  assert.strictEqual(d.spawn, false, 'at maxPods nothing is started');
  const cfgR = { ...cfg, maxHourlySpend: 2.4, maxPods: 4, scaleUpQueued: 9999 };
  d = P.planPods({ pods, waiting: 400, offers: [a5000], now: T0, cpu, learn }, { ...cfg, maxHourlySpend: 2.4, maxPods: 4, scaleUpQueued: 9999 }, st);
  assert.strictEqual(d.spawn, true); assert.match(d.reason, /replace l4/);
  // while the replacement boots nothing else is started
  const booting = [...pods, pod('new', 'NVIDIA RTX A5000', 0.27, 24, { state: 'booting', createdAt: new Date(T0 + 60000).toISOString() })];
  d = P.planPods({ pods: booting, waiting: 400, offers: [a5000], now: T0 + 90000, cpu, learn }, cfgR, st);
  assert.strictEqual(d.spawn, false); assert.strictEqual(d.drain, null);
  // the replacement is ready -> the L4 drains
  booting[3].state = 'ready';
  d = P.planPods({ pods: booting, waiting: 400, offers: [a5000], now: T0 + 180000, cpu, learn }, cfgR, st);
  assert.strictEqual(d.drain, 'l4');
  // no work waits and the free slots cover the worst pod: drain only after scaleDownMin
  const idle = [pod('l40', 'NVIDIA L40', 0.69, 48, { inflight: 2, safeConcurrency: 12 }), pod('rtx', 'NVIDIA RTX 4000 Ada Generation', 0.28, 20, { inflight: 1, safeConcurrency: 8 })];
  const st2 = {};
  assert.strictEqual(P.planPods({ pods: idle, waiting: 0, offers: [a5000], now: 0, cpu, learn }, cfg, st2).drain, null);
  assert.strictEqual(P.planPods({ pods: idle, waiting: 0, offers: [a5000], now: 5 * 60000, cpu, learn }, cfg, st2).drain, 'l40', 'L40 12/0.69 = 17.4 is worse than RTX 8/0.28');
  // over budget: nothing starts
  assert.strictEqual(P.planPods({ pods, waiting: 400, offers: [offer('NVIDIA L40', 'COMMUNITY', 0.79, 48)], now: 0, cpu, learn }, { ...cfg, maxHourlySpend: 1.7 }, {}).spawn, false);
});

test('live vCPU: offers without a >= min vCPU host drop out, the best tier is chosen and requested at create', async () => {
  const cfg = { ...P.DEFAULTS, enabled: true, gpuPick: 'value', minVcpuPerGpu: 16, vcpuTiers: [24, 32], minVramGb: 16 };
  const tiers = [16, 24, 32];
  assert.match(P.vcpuQuery(tiers), /c24: lowestPrice\(input: \{ gpuCount: 1, secureCloud: false, minVcpuCount: 24 \}\)/);
  const lp = (v, price, stock = 'Low') => ({ stockStatus: stock, minVcpu: v, uninterruptablePrice: price });
  const none = { stockStatus: null, minVcpu: null, uninterruptablePrice: null };
  const data = { gpuTypes: [
    { id: 'NVIDIA A40', s16: none, s24: none, s32: none, c16: none, c24: none, c32: none },               // only 9-vCPU hosts
    { id: 'NVIDIA L40', s16: lp(16, 0.79), s24: lp(24, 0.79), s32: none, c16: lp(16, 0.69), c24: lp(28, 0.69), c32: none },
    { id: 'NVIDIA GeForce RTX 4090', s16: none, s24: none, s32: none, c16: lp(30, 0.34), c24: lp(30, 0.34), c32: none } ] };
  const map = P.parseVcpu(data, tiers);
  assert.deepStrictEqual(map.get('NVIDIA A40|SECURE'), []);
  const list = [offer('NVIDIA A40', 'SECURE', 0.59, 48), offer('NVIDIA L40', 'COMMUNITY', 0.69, 48), offer('NVIDIA GeForce RTX 4090', 'COMMUNITY', 0.34, 24),
    offer('NVIDIA RTX A5000', 'SECURE', 0.27, 24)];
  const out = P.enrichOffers(list, cfg, map, 0.8);
  assert.deepStrictEqual(out.map(x => x.id), ['NVIDIA L40', 'NVIDIA GeForce RTX 4090', 'NVIDIA RTX A5000'], 'A40 dropped, unknown A5000 kept');
  const l40 = out.find(x => x.id === 'NVIDIA L40');
  assert.deepStrictEqual([l40.vcpu, l40.vcpuTier], [28, 24], 'tier 24 gives 12 slots (28 vCPU) instead of 8');
  // through the wrapped list: tiers are remembered and the create body asks for them
  const gl = P.wrapGpuList(async () => list, () => cfg, async q => ({ data }));
  const ordered = await gl({ settings: { maxFfmpegHourlyPrice: 0.8 } });
  assert.ok(!ordered.some(x => x.id === 'NVIDIA A40'));
  assert.strictEqual(P.tierFor('NVIDIA L40', 'COMMUNITY'), 24);
  const body = P.v2CreateBody({ name: 'x', imageName: 'i', cloudType: 'COMMUNITY', gpuTypeIds: ['NVIDIA L40'], minVCPUPerGPU: 4 }, cfg);
  assert.strictEqual(body.gpu.minVcpuCountPerGpu, 24);
  // a failing GraphQL keeps the stock list
  P.VCPU.at = 0; P.VCPU.map = new Map();
  const gl2 = P.wrapGpuList(async () => list, () => cfg, async () => { throw new Error('down'); });
  assert.strictEqual((await gl2({ settings: {} })).length, 4);
});

test('rescueFair: while renders wait in the pod rescue only a granted call takes a pod slot; grants expire', async () => {
  const stats = { overflowLocal: 0, podQueued: 0, noPodLocal: 0, spinupTriggers: 0, deterministicFailures: 0 };
  let calls = 0;
  const orig = async () => { calls++; return { podId: 'p', release() {}, reportSuccess() {}, reportFailure() {} }; };
  const acq = P.wrapAcquire(orig, fakeNative({ ready: [{}], free: {}, waiters: 0 }), () => P.DEFAULTS, stats);
  let waiting = 5;
  globalThis.__vfPodRescue = { stats: () => ({ waiting }) };
  globalThis.__vfPodRescueGrants = [];
  try {
    assert.strictEqual((await acq({ jobId: 'new' })).vfLocal, true, 'no grant, others wait: local');
    assert.strictEqual(stats.rescueFairLocal, 1);
    globalThis.__vfPodRescueGrants.push(Date.now());
    assert.strictEqual((await acq({ jobId: 'moved' })).podId, 'p');
    assert.strictEqual((await acq({ jobId: 'next' })).vfLocal, true, 'the grant is used up');
    globalThis.__vfPodRescueGrants.push(Date.now() - 20000);
    assert.strictEqual((await acq({ jobId: 'late' })).vfLocal, true, 'expired grant');
    assert.strictEqual((await acq({ jobId: 'spin', vfSpin: true })).podId, 'p', 'spin-up calls pass');
    waiting = 0;
    assert.strictEqual((await acq({ jobId: 'free' })).podId, 'p', 'nobody waits: as before');
    assert.strictEqual((await P.wrapAcquire(orig, fakeNative({ ready: [{}], free: {}, waiters: 0 }), () => ({ ...P.DEFAULTS, rescueFair: false }), stats)({ jobId: 'x' })).podId, 'p');
  } finally { delete globalThis.__vfPodRescue; delete globalThis.__vfPodRescueGrants; }
  assert.strictEqual(calls, 4);
});

test('hard budget: over maxHourlySpend the worst-value pod drains, one per decision, and nothing starts above it', () => {
  const cfg = { ...P.DEFAULTS, maxHourlySpend: 2.0, maxPods: 6, minVcpuPerGpu: 16 };
  const cpu = new Map(); const learn = memLearn();
  const pod = (id, gpuType, cost, vram, slots, extra = {}) => ({ id, gpuType, costPerHr: cost, vramGb: vram, state: 'ready', inflight: slots, safeConcurrency: slots, image: 'img', createdAt: '2026-11-21T10:00:00Z', capabilities: { render: true }, ...extra });
  const pods = [pod('l40', 'NVIDIA L40', 0.69, 48, 12), pod('rtx', 'NVIDIA RTX 4000 Ada Generation', 0.28, 20, 8), pod('l4a', 'NVIDIA L4', 0.69, 24, 8), pod('l4b', 'NVIDIA L4', 0.69, 24, 10)];
  let d = P.planPods({ pods, waiting: 500, offers: [offer('NVIDIA RTX A4000', 'SECURE', 0.25, 16)], now: 0, cpu, learn }, cfg, {});
  assert.strictEqual(d.drain, 'l4a'); assert.match(d.reason, /over budget: \$2\.35/); assert.strictEqual(d.spawn, false);
  // the draining pod is still billed: 2.35 + 0.25 > 2.0 -> no scale-up yet, and no second drain (1.66 committed)
  pods[2].image = 'img#vf-drain';
  d = P.planPods({ pods, waiting: 500, offers: [offer('NVIDIA RTX A4000', 'SECURE', 0.25, 16)], now: 0, cpu, learn }, cfg, {});
  assert.strictEqual(d.drain, null); assert.strictEqual(d.spawn, false);
  // it is gone: 1.66 + 0.25 <= 2.0 -> scale up; 1.66 + 0.69 would not fit
  const left = pods.filter(p => p.id !== 'l4a');
  assert.strictEqual(P.planPods({ pods: left, waiting: 500, offers: [offer('NVIDIA RTX A4000', 'SECURE', 0.25, 16)], now: 0, cpu, learn }, cfg, {}).spawn, true);
  assert.strictEqual(P.planPods({ pods: left, waiting: 500, offers: [offer('NVIDIA L4', 'SECURE', 0.69, 24)], now: 0, cpu, learn }, cfg, {}).spawn, false);
  assert.strictEqual(P.DEFAULTS.maxHourlySpend, 2.0);
});

test('scale-up starts a pod through the stock spin-up even when the pool queue is empty; nothing while one is being created', () => {
  const pods = [{ id: 'a', gpuType: 'NVIDIA L40', cloudType: 'COMMUNITY', costPerHr: 0.69, vramGb: 48, state: 'ready', inflight: 12, safeConcurrency: 12, image: 'img', createdAt: '2026-11-21T10:00:00Z', readyAt: '2026-11-21T10:06:00Z', capabilities: { render: true } }];
  const pool = { pods, waiters: [], spinups: new Set() };
  const spun = []; let seenWaiters = -1; const saved = [];
  let s = { gpuFfmpegEnabled: true, workloads: { compositions: false, brollAnalysis: false, siglip: false, animations: true, infographics: true }, maxFfmpegPods: 1 };
  const native = { lane: k => ({ waiters: new Array(k === 'render' ? 1000 : 10) }), settings: () => s, saveSettings: p => { saved.push(p); s = { ...s, ...p }; }, pool: () => pool,
    spin: j => { seenWaiters = pool.waiters.length; spun.push(j); } };
  globalThis.__vfRunpodOffers = { at: 0, list: [offer('NVIDIA RTX A4000', 'SECURE', 0.25, 16)] };
  globalThis.__vfPodRescue = { stats: () => ({ waiting: 400 }), rescue: { entries: [{ jobId: 'job-1', done: false }] } };
  try {
    const cfg = { ...P.DEFAULTS, liveVcpu: false, controller: { ...P.DEFAULTS.controller, combined: true } };
    const c = P.createController(native, () => cfg, {}, () => {}, () => 0);
    assert.strictEqual(c.tick(), 'on');
    assert.deepStrictEqual(spun, ['job-1']); assert.strictEqual(seenWaiters, 1, 'a stand-in waiter existed during the call');
    assert.strictEqual(pool.waiters.length, 0, 'and is gone afterwards');
    assert.strictEqual(s.maxFfmpegPods, 2);
    pool.spinups.add('creating');
    c.tick();
    assert.strictEqual(spun.length, 1, 'no second start while a pod is being created');
  } finally { delete globalThis.__vfRunpodOffers; delete globalThis.__vfPodRescue; }
});

test('budget room: scale-up takes the best offer that fits, a booting pod is cancelled before a working one drains, the create list is cut to the room', async () => {
  const cfg = { ...P.DEFAULTS, enabled: true, maxHourlySpend: 2.0, maxPods: 6, minVcpuPerGpu: 16, liveVcpu: false };
  const cpu = new Map(); const learn = memLearn();
  const pod = (id, gpuType, cost, vram, slots, extra = {}) => ({ id, gpuType, costPerHr: cost, vramGb: vram, state: 'ready', inflight: slots, safeConcurrency: slots, image: 'img', createdAt: '2026-11-21T10:00:00Z', capabilities: { render: true }, ...extra });
  const pods = [pod('l40', 'NVIDIA L40', 0.69, 48, 12), pod('rtx', 'NVIDIA RTX 4000 Ada Generation', 0.28, 20, 8), pod('l4', 'NVIDIA L4', 0.69, 24, 10)];
  const offers = [offer('NVIDIA L40S', 'COMMUNITY', 0.79, 48), offer('NVIDIA RTX A4000', 'SECURE', 0.25, 16)];
  // spend 1.66: the L40S (0.79) does not fit, the A4000 (0.25) does
  let d = P.planPods({ pods, waiting: 400, offers, now: 0, cpu, learn }, cfg, {});
  assert.strictEqual(d.spawn, true); assert.match(d.best, /A4000/);
  assert.strictEqual(P.planPods({ pods, waiting: 400, offers: [offers[0]], now: 0, cpu, learn }, cfg, {}).spawn, false);
  // an over-budget pod that still boots is cancelled; the working pods stay
  const withBoot = [...pods, pod('new', 'NVIDIA L4', 0.69, 24, 0, { state: 'booting', createdAt: '2026-11-21T13:57:00Z' })];
  d = P.planPods({ pods: withBoot, waiting: 400, offers, now: 0, cpu, learn }, cfg, {});
  assert.strictEqual(d.cancel, 'new'); assert.strictEqual(d.drain, null);
  // the list the stock create loop gets: only what fits 2.00 - 1.66
  const gl = P.wrapGpuList(async () => offers, () => cfg, null, () => pods);
  assert.deepStrictEqual((await gl({ settings: {} })).map(x => x.id), ['NVIDIA RTX A4000']);
  assert.strictEqual(globalThis.__vfRunpodOffers.list.length, 2, 'planning still sees every offer');
  const glOpen = P.wrapGpuList(async () => offers, () => ({ ...cfg, podScaling: false }), null, () => pods);
  assert.strictEqual((await glOpen({ settings: {} })).length, 2);
  delete globalThis.__vfRunpodOffers;
});

test('a cancelled booting pod leaves a stale spin-up entry: the next scale-up is not blocked by it', () => {
  const mkPod = (id, cost, state, extra = {}) => ({ id, gpuType: 'NVIDIA L4', cloudType: 'SECURE', costPerHr: cost, vramGb: 24, state, inflight: state === 'ready' ? 8 : 0, safeConcurrency: 8, image: 'img', createdAt: '2026-11-21T10:00:00Z', readyAt: '2026-11-21T10:20:00Z', capabilities: { render: true }, ...extra });
  const pool = { pods: [mkPod('a', 0.69, 'ready'), mkPod('b', 0.69, 'ready'), mkPod('c', 0.69, 'booting', { createdAt: '2026-11-21T13:57:00Z' })], waiters: [], spinups: new Set(['boot-c']) };
  const spun = [], killed = []; let now = 0;
  let s = { gpuFfmpegEnabled: true, workloads: { compositions: false, brollAnalysis: false, siglip: false, animations: true, infographics: true }, maxFfmpegPods: 3 };
  const native = { lane: k => ({ waiters: new Array(k === 'render' ? 1000 : 10) }), settings: () => s, saveSettings: p => { s = { ...s, ...p }; }, pool: () => pool,
    spin: j => spun.push(j), terminatePod: p => { killed.push(p.id); pool.pods = pool.pods.filter(x => x.id !== p.id); } };
  globalThis.__vfRunpodOffers = { at: 0, list: [offer('NVIDIA RTX A4000', 'SECURE', 0.25, 16)] };
  globalThis.__vfPodRescue = { stats: () => ({ waiting: 400 }), rescue: { entries: [{ jobId: 'job-1', done: false }] } };
  try {
    const cfg = { ...P.DEFAULTS, liveVcpu: false, maxHourlySpend: 2.0, controller: { ...P.DEFAULTS.controller, combined: true } };
    const c = P.createController(native, () => cfg, {}, () => {}, () => now);
    c.tick();                                  // 2.07 > 2.00: the booting pod is stopped
    assert.deepStrictEqual(killed, ['c']); assert.deepStrictEqual(spun, []);
    now = 60000; c.tick();                     // its spin-up entry is still there, but 1.38 + 0.25 fits: scale up
    assert.deepStrictEqual(spun, ['job-1']);
    assert.strictEqual(s.maxFfmpegPods, 3);
  } finally { delete globalThis.__vfRunpodOffers; delete globalThis.__vfPodRescue; }
});

test('pod robustness: a timed-out status poll is repeated, a cancel is not; transient errors do not count against a pod', async () => {
  const stats = { overflowLocal: 0, podQueued: 0, noPodLocal: 0, spinupTriggers: 0, deterministicFailures: 0 };
  let calls = 0;
  const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const flaky = async (url, init) => { calls++; if (calls < 3) throw timeoutErr(); return { ok: true, url }; };
  const f = P.wrapRenderFetch(flaky, () => P.DEFAULTS, stats, async () => {});
  const timedOut = AbortSignal.abort(timeoutErr());
  assert.strictEqual((await f('https://pod/v1/jobs/abc?wait=20', { signal: timedOut })).ok, true);
  assert.strictEqual(calls, 3); assert.strictEqual(stats.renderPollRetries, 2);
  // job cancelled by the caller: no retry
  calls = 0;
  const cancelled = AbortSignal.abort(new Error('Render job stopped'));
  await assert.rejects(f('https://pod/v1/jobs/abc?wait=20', { signal: cancelled }));
  assert.strictEqual(calls, 1);
  // other requests (submit, output) are not repeated
  calls = 0;
  await assert.rejects(f('https://pod/v1/jobs', { method: 'POST' }));
  assert.strictEqual(calls, 1);
  // a poll timeout is not counted against the pod; a pod that mostly fails still is
  let counted = 0;
  const orig = async () => ({ podId: 'p', reportFailure: async () => { counted++; return 'counted'; }, reportSuccess() {}, release() {} });
  const acq = P.wrapAcquire(orig, fakeNative({ ready: [{}], free: {}, waiters: 0 }), () => ({ ...P.DEFAULTS, rescueFair: false }), stats);
  for (let i = 0; i < 20; i++) (await acq({})).reportSuccess();
  const err = new Error('render agent GET /v1/jobs/x?wait=20: network error: The operation was aborted due to timeout');
  assert.strictEqual(await (await acq({})).reportFailure(err), undefined);
  assert.strictEqual(counted, 0); assert.strictEqual(stats.transientFailures, 1);
  assert.strictEqual(await (await acq({})).reportFailure(new Error('HyperFrames render crashed')), 'counted');
});

test('scale-up is boot-aware: no new pod when the running pods finish the queue before it has booted', () => {
  const cfg = { ...P.DEFAULTS, maxHourlySpend: 2.0, maxPods: 6, minVcpuPerGpu: 16, scaleUpQueued: 8, renderMinutes: 6 };
  const cpu = new Map();
  const learn = memLearn({ 'NVIDIA L4|SECURE': { vcpu: 25, bootMin: 12 } });
  const pods = [{ id: 'a', gpuType: 'NVIDIA L4', costPerHr: 0.69, vramGb: 24, state: 'ready', inflight: 10, safeConcurrency: 10, image: 'img', createdAt: '2026-11-21T18:04:00Z', capabilities: { render: true } }];
  const offers = [offer('NVIDIA L4', 'SECURE', 0.69, 24)];
  // 10 slots finish 10 * 12 / 6 = 20 renders during a 12-min boot: 8 + 20 = 28 must wait
  let d = P.planPods({ pods, waiting: 22, offers, now: 0, cpu, learn }, cfg, {});
  assert.strictEqual(d.spawn, false); assert.strictEqual(d.needWaiting, 28);
  d = P.planPods({ pods, waiting: 53, offers, now: 0, cpu, learn }, cfg, {});
  assert.strictEqual(d.spawn, true);
  // no pod yet: the plain threshold applies
  assert.strictEqual(P.planPods({ pods: [], waiting: 8, offers, now: 0, cpu, learn }, cfg, {}).spawn, true);
});

test('brollAboveFfmpeg 0 = no gate: a running pod keeps b-roll work at any queue, also while animations wait', () => {
  const c = { workloads: ['brollAnalysis', 'animations', 'infographics'], onAbove: 2000, offBelow: 800, renderOnAbove: 30, renderOffBelow: 0, brollAboveFfmpeg: 0 };
  assert.strictEqual(P.wantedWorkloads(c, 2629, {}, 6).brollAnalysis, true);
  assert.strictEqual(P.wantedWorkloads(c, 10, { brollAnalysis: true }, 400).brollAnalysis, true);
  assert.strictEqual(P.wantedWorkloads(c, 0, {}, 0).animations, true);
  // without the knob the old gates stay: jam only, and not while animations wait
  const d = { ...c, brollAboveFfmpeg: undefined };
  assert.strictEqual(P.wantedWorkloads(d, 2629, {}, 6).brollAnalysis, false);
  assert.strictEqual(P.wantedWorkloads(d, 2629, {}, 0).brollAnalysis, true);
  assert.strictEqual(P.wantedWorkloads(d, 500, {}, 0).brollAnalysis, false);
});
