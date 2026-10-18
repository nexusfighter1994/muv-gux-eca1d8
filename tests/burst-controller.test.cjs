'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { createBurstController, workerEnvelope, NAME_PREFIX, STOCK_IMAGE } = require('../node/runpod/burst-controller.cjs');

function world({ settings = {}, apiKey = 'rpa_TESTKEY0123456789', prices = null, costPerHr = 0.2, healthy = true, health = {} } = {}) {
  const w = { t: Date.parse('2026-10-17T12:00:00Z'), queue: 0, calls: [], pods: new Map(), saved: null, healthy, created: [] };
  w.settings = { burstEnabled: true, burstStartQueue: 200, burstStopQueue: 10, burstMaxCents: 30, burstMaxHours: 12, ...settings };
  w.apiKey = apiKey;
  const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  w.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    w.calls.push([method, String(url)]);
    if (String(url).startsWith('https://api.runpod.io/graphql')) {
      return json(200, { data: { gpuTypes: prices || [
        { id: 'NVIDIA RTX A4000', memoryInGb: 16, communityCloud: true, secureCloud: true, communityPrice: 0.17, securePrice: 0.32 },
        { id: 'NVIDIA GeForce RTX 3070', memoryInGb: 8, communityCloud: true, secureCloud: false, communityPrice: 0.13, securePrice: 0 },
        { id: 'NVIDIA RTX 4090', memoryInGb: 24, communityCloud: true, secureCloud: true, communityPrice: 0.69, securePrice: 0.89 },
        { id: 'Tiny', memoryInGb: 4, communityCloud: true, secureCloud: true, communityPrice: 0.05, securePrice: 0.06 }] } });
    }
    const path = String(url).replace('https://rest.runpod.io/v1', '');
    if (method === 'POST' && path === '/pods') {
      const spec = JSON.parse(init.body);
      w.created.push(spec);
      const id = 'pod' + w.created.length;
      w.pods.set(id, { id, name: spec.name });
      return json(201, { id, name: spec.name, costPerHr: costPerHr, desiredStatus: 'RUNNING' });
    }
    if (method === 'DELETE' && path.startsWith('/pods/')) { w.pods.delete(decodeURIComponent(path.slice(6))); return json(200); }
    if (method === 'GET' && path === '/pods') return json(200, [...w.pods.values()]);
    if (String(url).endsWith('/health')) {
      assert.match(init.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
      return w.healthy ? json(200, { ok: true, slots: 2, hyperframes: '0.7.90', node: 'v22.23.3', cpus: 8, ...health }) : json(503, { ok: false });
    }
    return json(404, {});
  };
  w.controller = createBurstController({ fetchImpl: w.fetch, now: () => w.t, readSettings: () => w.settings, readApiKey: () => w.apiKey,
    queueLength: () => w.queue, bundleFiles: () => ({ 'pod-worker.mjs': 'console.log("worker")', 'boot.sh': 'echo boot' }), loadState: () => w.saved, saveState: s => { w.saved = JSON.parse(JSON.stringify(s)); },
    localRuntime: { hyperframes: '0.7.90', node: 'v22.23.3' } });
  w.advance = ms => { w.t += ms; };
  return w;
}

test('starts the cheapest GPU within the cap (>= 8 GB, community first) when the queue reaches the start mark', async () => {
  const w = world();
  w.queue = 199;
  await w.controller.tick();
  assert.equal(w.created.length, 0, 'below the start mark');
  w.queue = 200;
  await w.controller.tick();
  assert.equal(w.created.length, 1);
  const spec = w.created[0];
  assert.deepEqual(spec.gpuTypeIds, ['NVIDIA RTX A4000', 'NVIDIA GeForce RTX 3070'], 'within $0.30/h, >= 8 GB, strongest (priciest) first');
  assert.equal(spec.gpuTypePriority, 'custom');
  assert.deepEqual(w.controller.status().gpus.map(g => g.id), ['NVIDIA RTX 4090', 'NVIDIA RTX A4000', 'NVIDIA GeForce RTX 3070'], 'GPU list for the UI (>= 8 GB), strongest first');
  assert.equal(spec.cloudType, 'COMMUNITY');
  assert.equal(spec.imageName, STOCK_IMAGE);
  assert.ok(spec.name.startsWith(NAME_PREFIX));
  assert.deepEqual(spec.ports, ['8080/http']);
  assert.match(spec.env.VF_POD_TOKEN, /^[a-f0-9]{64}$/);
  const script = zlib.gunzipSync(Buffer.from(spec.env.VF_POD_BUNDLE, 'base64')).toString();
  assert.match(script, /base64 -d > \/opt\/vf-pod\/pod-worker\.mjs <<'VFEOF'/);
  assert.ok(script.includes(Buffer.from('console.log("worker")').toString('base64')));
  assert.match(script, /exec bash \/opt\/vf-pod\/boot\.sh\n$/);
  assert.deepEqual(spec.dockerStartCmd, ['bash', '-c', 'echo "$VF_POD_BUNDLE" | base64 -d | gunzip | bash']);
  assert.equal(w.controller.status().pod.ready, false);
  assert.equal(w.controller.acquire(), null, 'not ready yet: no lease');
  w.advance(15000); await w.controller.tick();
  assert.equal(w.controller.status().pod.ready, true);
  const lease = w.controller.acquire();
  assert.equal(lease.endpoint, 'https://pod1-8080.proxy.runpod.net');
  assert.ok(w.controller.acquire(), 'second slot');
  assert.equal(w.controller.acquire(), null, 'pod reports 2 slots');
  lease.release(); lease.release();
  assert.ok(w.controller.acquire());
});

test('a pod whose real costPerHr exceeds the cap is terminated at once and the start cools down', async () => {
  const w = world({ costPerHr: 0.45 });
  w.queue = 500;
  await w.controller.tick();
  assert.equal(w.created.length, 1);
  assert.equal(w.pods.size, 0, 'terminated');
  assert.equal(w.controller.status().pod, null);
  w.advance(15000); await w.controller.tick();
  assert.equal(w.created.length, 1, 'cool-down: no second try right away');
});

test('stops after the queue stayed at or below the stop mark for 5 minutes with nothing in flight', async () => {
  const w = world();
  w.queue = 300; await w.controller.tick();
  w.advance(15000); await w.controller.tick();
  const lease = w.controller.acquire();
  w.queue = 5;
  for (let i = 0; i < 25; i++) { w.advance(15000); await w.controller.tick(); }
  assert.equal(w.pods.size, 1, 'a render in flight keeps the pod');
  lease.release();
  w.advance(15000); await w.controller.tick();
  assert.equal(w.pods.size, 0);
  w.queue = 50; w.advance(15000); await w.controller.tick();
  assert.equal(w.created.length, 1, 'no restart between the marks');
});

test('daily hour limit, disable and unhealthy pods terminate; the ledger counts cost', async () => {
  const w = world({ settings: { burstMaxHours: 1 } });
  w.queue = 300; await w.controller.tick();
  for (let i = 0; i < 245; i++) { w.advance(15000); await w.controller.tick(); }
  assert.equal(w.pods.size, 0, 'stopped at 1 h');
  assert.ok(w.controller.status().ledger.seconds >= 3600);
  assert.ok(Math.abs(w.controller.status().ledger.cents - 20) < 1, 'about 20 cents for 1 h at $0.20/h');
  w.advance(60000); await w.controller.tick();
  assert.equal(w.created.length, 1, 'no new pod the same day');

  const d = world();
  d.queue = 300; await d.controller.tick();
  d.settings.burstEnabled = false; d.apiKey = '';
  d.advance(15000); await d.controller.tick();
  assert.equal(d.pods.size, 0, 'disabled (even with the key removed) terminates with the remembered key');

  const u = world();
  u.queue = 300; await u.controller.tick();
  u.advance(15000); await u.controller.tick();
  u.healthy = false;
  for (let i = 0; i < 14; i++) { u.advance(15000); await u.controller.tick(); }
  assert.equal(u.pods.size, 0, 'unhealthy > 3 min terminates');
});

test('startup timeout and an incompatible runtime terminate; the watchdog kills orphan vf-burst pods only', async () => {
  const w = world({ health: { hyperframes: '0.7.91' } });
  w.queue = 300; await w.controller.tick();
  for (let i = 0; i < 61; i++) { w.advance(15000); await w.controller.tick(); }
  assert.equal(w.pods.size, 0, 'never ready: terminated after the startup deadline');
  assert.match(w.controller.status().events.map(e => e.event + ' ' + (e.reason || '')).join('|'), /runtime 0\.7\.91/);

  const o = world();
  o.pods.set('old1', { id: 'old1', name: NAME_PREFIX + 'abc' });
  o.pods.set('foreign', { id: 'foreign', name: 'avatarforge-pod' });
  await o.controller.tick();
  assert.ok(!o.pods.has('old1'), 'orphan vf-burst pod terminated');
  assert.ok(o.pods.has('foreign'), 'other pods are never touched');
});

test('state survives a restart (pod adopted, ledger kept); no key or disabled never creates pods', async () => {
  const w = world();
  w.queue = 300; await w.controller.tick();
  const saved = w.saved;
  assert.ok(!JSON.stringify(saved).includes('rpa_'), 'the API key is never written to the state file');
  const again = createBurstController({ fetchImpl: w.fetch, now: () => w.t, readSettings: () => w.settings, readApiKey: () => w.apiKey,
    queueLength: () => w.queue, bundleFiles: () => ({}), loadState: () => saved, saveState() {} });
  assert.equal(again.status().pod.id, 'pod1');
  const n = world({ apiKey: '' }); n.queue = 999; await n.controller.tick();
  const off = world({ settings: { burstEnabled: false } }); off.queue = 999; await off.controller.tick();
  assert.equal(n.created.length + off.created.length, 0);
});

test('worker envelope is gzip+base64 of the source', () => {
  assert.equal(zlib.gunzipSync(Buffer.from(workerEnvelope('abc'), 'base64')).toString(), 'abc');
});

test('the GPU selection from /custom limits the offer; the strongest allowed one within the cap comes first', async () => {
  const w = world({ settings: { burstGpuTypes: ['NVIDIA GeForce RTX 3070', 'NVIDIA RTX 4090'] } });
  w.queue = 300; await w.controller.tick();
  assert.deepEqual(w.created[0].gpuTypeIds, ['NVIDIA GeForce RTX 3070'], '4090 is above the cap, A4000 not selected');
  const none = world({ settings: { burstGpuTypes: ['NVIDIA RTX 4090'] } });
  none.queue = 300; await none.controller.tick();
  assert.equal(none.created.length, 0, 'nothing selected within the cap: no pod');
  assert.match(none.controller.status().lastError, /no pod within the price cap/);
});

test('createDefaultBurst wires the runtime files, the scheduler lane and the worker source', async () => {
  const { createDefaultBurst } = require('../node/runpod/burst-controller.cjs');
  const files = { '/data/runtime/pc-boost.json': JSON.stringify({ burstEnabled: false }) };
  for (const name of require('../node/runpod/burst-controller.cjs').BUNDLE) files['/w/' + name] = 'SRC ' + name;
  const fsStub = { readFileSync: f => { if (!(f in files)) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); return files[f]; }, writeFileSync() {}, renameSync() {} };
  const saved = globalThis.__vfSchedulerLane;
  globalThis.__vfSchedulerLane = lane => ({ waiters: lane === 'render' ? [{ resourceKey: 'frameshift' }, { resourceKey: 'remotion' }, { resourceKey: 'frameshift' }] : [] });
  try {
    const c = createDefaultBurst({ here: '/w', fs: fsStub, path: require('node:path').posix, env: {}, log() {} });
    await c.tick();
    assert.equal(c.status().pod, null);
    assert.throws(() => createDefaultBurst({}), /here/);
  } finally { if (saved === undefined) delete globalThis.__vfSchedulerLane; else globalThis.__vfSchedulerLane = saved; }
});

test('bundle script refuses unsafe paths', () => {
  const { bundleScript } = require('../node/runpod/burst-controller.cjs');
  for (const name of ['../x', '/abs', 'a b', 'x/../../y']) assert.throws(() => bundleScript({ [name]: 'x' }), /bundle path/, name);
});
