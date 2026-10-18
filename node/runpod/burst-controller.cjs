'use strict';
// RunPod burst: while many frameshift renders wait, rent ONE cheap GPU pod that renders them
// with the exact stock runtime (pod-worker.mjs), and give it back when the queue is short.
// Hard limits: price per hour (checked against RunPod's own costPerHr), hours per day, a
// startup deadline, an unhealthy deadline and a watchdog that terminates any other vf-burst pod.
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const REST = 'https://rest.runpod.io/v1';
const GRAPHQL = 'https://api.runpod.io/graphql';
const NAME_PREFIX = 'vf-burst-';
const PORT = 8080;
// The stock VidForge image: its frameshift runtime is the server's, so pod output equals native.
const STOCK_IMAGE = 'afflicted9436/tayzu31t3@sha256:f1e9c60fdfb3593d747bc3c2aa56bd8700a2c23f3706ba60459c282c6b520c67';
const TIMING = Object.freeze({
  tickMs: 15000, healthEveryMs: 30000, startupMs: 15 * 60000, unhealthyMs: 3 * 60000,
  lowQueueMs: 5 * 60000, watchdogMs: 10 * 60000, startFailCooldownMs: 30 * 60000, unhealthyCooldownMs: 15 * 60000,
});

const day = ms => new Date(ms).toISOString().slice(0, 10);
const usd = cents => cents / 100;

function workerEnvelope(source) {
  return zlib.gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64');
}
// The pod bundle: a shell script writing each file from base64 and starting boot.sh, gzip+base64
// in one env variable (dockerStartCmd: decode | gunzip | bash) - no registry, no quoting issues.
const POD_DIR = '/opt/vf-pod';
function bundleScript(files) {
  const lines = ['set -e', `mkdir -p ${POD_DIR}`];
  for (const [name, content] of Object.entries(files)) {
    if (!/^[a-z0-9_.-]+(\/[a-z0-9_.-]+)*$/i.test(name) || name.includes('..')) throw Error('bundle path ' + name);
    const b64 = Buffer.from(content).toString('base64').replace(/.{1,76}/g, '$&\n');
    lines.push(`mkdir -p "$(dirname ${POD_DIR}/${name})"`, `base64 -d > ${POD_DIR}/${name} <<'VFEOF'`, b64.trimEnd(), 'VFEOF');
  }
  lines.push(`exec bash ${POD_DIR}/boot.sh`);
  return lines.join('\n') + '\n';
}
const bundleEnvelope = files => workerEnvelope(bundleScript(files));

function createBurstController({ fetchImpl = fetch, now = Date.now, readSettings, readApiKey, queueLength,
  bundleFiles, loadState, saveState, log = () => {}, localRuntime = null, timing = TIMING } = {}) {
  for (const [name, fn] of Object.entries({ readSettings, readApiKey, queueLength, bundleFiles, loadState, saveState })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a function');
  }
  let state = { pod: null, ledger: { day: day(now()), seconds: 0, cents: 0 }, lowSince: null, cooldownUntil: 0, lastError: null,
    lastWatchdogAt: 0, lastTickAt: 0, ...(safe(loadState) || {}) };
  // The last API key stays in memory only, so a pod can still be terminated after the key was removed.
  let inflight = 0, timer = null, ticking = false, lastKey = '';
  const events = [];
  const note = (event, extra = {}) => {
    const entry = { at: new Date(now()).toISOString(), event, ...extra };
    events.push(entry); if (events.length > 40) events.shift();
    log(`[vf-burst] ${event}${extra.reason ? ': ' + extra.reason : ''}`);
  };
  const persist = () => { try { saveState(state); } catch (error) { note('state save failed', { reason: String(error?.message || error) }); } };

  function safe(fn) { try { return fn(); } catch { return null; } }
  async function api(apiKey, method, path, body) {
    const response = await fetchImpl(REST + path, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    if (!response.ok) throw Object.assign(Error(`RunPod ${method} ${path} -> HTTP ${response.status}`), { status: response.status, detail: text.slice(0, 300) });
    return text ? JSON.parse(text) : null;
  }
  let catalog = { at: 0, types: [] };
  async function gpuTypes(apiKey) {
    if (now() - catalog.at < 10 * 60000 && catalog.types.length) return catalog.types;
    const response = await fetchImpl(GRAPHQL, { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query { gpuTypes { id displayName memoryInGb communityCloud secureCloud communityPrice securePrice } }' }) });
    if (!response.ok) throw Error('RunPod gpuTypes -> HTTP ' + response.status);
    const types = ((await response.json())?.data?.gpuTypes || []).filter(t => t && typeof t.id === 'string');
    catalog = { at: now(), types };
    return types;
  }
  // Allowed types (all when the list is empty) within the cap, STRONGEST first: RunPod takes
  // the first one in this order that is available. Price is the strength proxy (RunPod prices
  // track performance), then memory.
  async function gpuOffers(apiKey, maxUsd, allowed = []) {
    const types = await gpuTypes(apiKey);
    const pick = (cloud, priceKey) => types
      .filter(t => t[cloud] && Number.isFinite(t[priceKey]) && t[priceKey] > 0 && t[priceKey] <= maxUsd && (t.memoryInGb || 0) >= 8
        && (!allowed.length || allowed.includes(t.id)))
      .sort((a, b) => b[priceKey] - a[priceKey] || (b.memoryInGb || 0) - (a.memoryInGb || 0)).slice(0, 12).map(t => ({ id: t.id, price: t[priceKey] }));
    return { COMMUNITY: pick('communityCloud', 'communityPrice'), SECURE: pick('secureCloud', 'securePrice') };
  }
  function podSpec(token, cloudType, offers) {
    return { name: NAME_PREFIX + crypto.randomBytes(3).toString('hex'), cloudType, computeType: 'GPU',
      gpuTypeIds: offers.map(o => o.id), gpuTypePriority: 'custom', gpuCount: 1, minVCPUPerGPU: 4, minRAMPerGPU: 16,
      imageName: STOCK_IMAGE, containerDiskInGb: 30, volumeInGb: 0, ports: [`${PORT}/http`], interruptible: false,
      env: { VF_POD_TOKEN: token, VF_POD_BUNDLE: bundleEnvelope(bundleFiles()), VF_POD_PORT: String(PORT), VF_SIGLIP_CONCURRENCY: '4' },
      dockerStartCmd: ['bash', '-c', 'echo "$VF_POD_BUNDLE" | base64 -d | gunzip | bash'] };
  }

  async function start(settings, apiKey) {
    const maxUsd = usd(settings.burstMaxCents);
    let offers;
    try { offers = await gpuOffers(apiKey, maxUsd, Array.isArray(settings.burstGpuTypes) ? settings.burstGpuTypes : []); }
    catch (error) { state.lastError = String(error.message); state.cooldownUntil = now() + timing.startFailCooldownMs; note('price lookup failed', { reason: state.lastError }); persist(); return; }
    const token = crypto.randomBytes(32).toString('hex');
    for (const cloudType of ['COMMUNITY', 'SECURE']) {
      if (!offers[cloudType].length) continue;
      let pod;
      try { pod = await api(apiKey, 'POST', '/pods', podSpec(token, cloudType, offers[cloudType])); }
      catch (error) { note('create failed', { reason: `${cloudType}: ${error.message}` }); continue; }
      if (!pod?.id) continue;
      const cost = Number(pod.costPerHr);
      state.pod = { id: pod.id, name: pod.name, cloudType, createdAt: now(), costPerHr: Number.isFinite(cost) ? cost : null, token,
        endpoint: `https://${pod.id}-${PORT}.proxy.runpod.net`, readyAt: null, lastHealthyAt: null, lastHealthAt: 0, health: null,
        gpu: pod.machine?.gpuTypeId || pod.gpu?.id || offers[cloudType][0].id };
      note('pod created', { reason: `${state.pod.id} ${cloudType} ${state.pod.gpu} $${cost}/h` });
      persist();
      if (!Number.isFinite(cost) || cost > maxUsd + 1e-9) {
        await stop(apiKey, `price $${pod.costPerHr}/h above the cap $${maxUsd}/h`);
        state.cooldownUntil = now() + timing.startFailCooldownMs;
        persist();
      }
      return;
    }
    state.lastError = 'no pod within the price cap available';
    state.cooldownUntil = now() + timing.startFailCooldownMs;
    note('start failed', { reason: state.lastError });
    persist();
  }
  async function stop(apiKey, reason) {
    const pod = state.pod;
    if (!pod) return;
    try { await api(apiKey, 'DELETE', '/pods/' + encodeURIComponent(pod.id)); }
    catch (error) { if (error.status !== 404) { state.lastError = 'terminate failed: ' + error.message; note('terminate failed', { reason: error.message }); persist(); return; } }
    note('pod terminated', { reason: `${pod.id}: ${reason}` });
    state.pod = null; state.lowSince = null;
    persist();
  }
  async function checkHealth(pod) {
    try {
      const response = await fetchImpl(pod.endpoint + '/health', { headers: { Authorization: 'Bearer ' + pod.token }, signal: AbortSignal.timeout(10000) });
      const body = response.ok ? await response.json() : null;
      const compatible = body?.ok === true && Number.isInteger(body.slots) && body.slots >= 1
        && (!localRuntime || (body.hyperframes === localRuntime.hyperframes && body.node === localRuntime.node));
      pod.health = body ? { slots: body.slots, hyperframes: body.hyperframes, node: body.node, cpus: body.cpus, gpu: body.gpu, active: body.active } : null;
      if (compatible) { pod.lastHealthyAt = now(); if (!pod.readyAt) { pod.readyAt = now(); note('pod ready', { reason: `${pod.id} slots ${body.slots}` }); } }
      else if (body?.ok === true) pod.incompatible = `runtime ${body.hyperframes}/${body.node} != server ${localRuntime?.hyperframes}/${localRuntime?.node}`;
    } catch { /* not ready or unreachable */ }
    pod.lastHealthAt = now();
  }
  async function watchdog(apiKey) {
    state.lastWatchdogAt = now();
    let pods;
    try { pods = await api(apiKey, 'GET', '/pods'); } catch { return; }
    for (const pod of Array.isArray(pods) ? pods : []) {
      if (typeof pod?.name === 'string' && pod.name.startsWith(NAME_PREFIX) && pod.id !== state.pod?.id) {
        try { await api(apiKey, 'DELETE', '/pods/' + encodeURIComponent(pod.id)); note('watchdog terminated orphan', { reason: pod.id }); }
        catch (error) { note('watchdog terminate failed', { reason: `${pod.id}: ${error.message}` }); }
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const t = now(), settings = safe(readSettings) || {}, apiKey = safe(readApiKey) || '';
      if (apiKey) lastKey = apiKey;
      if (state.ledger.day !== day(t)) state.ledger = { day: day(t), seconds: 0, cents: 0 };
      if (state.pod && state.lastTickAt) {
        const dt = Math.max(0, Math.min(t - state.lastTickAt, 120000)) / 1000;
        state.ledger.seconds += dt;
        if (Number.isFinite(state.pod.costPerHr)) state.ledger.cents += state.pod.costPerHr * 100 * dt / 3600;
      }
      state.lastTickAt = t;
      if (apiKey && now() - catalog.at >= 10 * 60000) { try { await gpuTypes(apiKey); } catch { /* the GPU list stays as it was */ } }
      const enabled = settings.burstEnabled === true && Boolean(apiKey);
      if (!enabled) { if (state.pod && (apiKey || lastKey)) await stop(apiKey || lastKey, 'disabled'); persist(); return; }
      const queued = Number(safe(queueLength)) || 0;
      state.queued = queued;
      const dailyCap = (settings.burstMaxHours || 0) * 3600;
      if (state.pod) {
        const pod = state.pod;
        if (state.ledger.seconds >= dailyCap) { await stop(apiKey, 'daily hour limit'); return; }
        if (!pod.readyAt) {
          await checkHealth(pod);
          if (!pod.readyAt && t - pod.createdAt > timing.startupMs) { await stop(apiKey, pod.incompatible || 'startup timeout'); state.cooldownUntil = t + timing.startFailCooldownMs; persist(); return; }
        } else {
          if (t - pod.lastHealthAt >= timing.healthEveryMs) await checkHealth(pod);
          if (t - (pod.lastHealthyAt || pod.readyAt) > timing.unhealthyMs) { await stop(apiKey, 'unhealthy'); state.cooldownUntil = t + timing.unhealthyCooldownMs; persist(); return; }
        }
        if (queued <= settings.burstStopQueue) {
          state.lowSince ??= t;
          if (t - state.lowSince >= timing.lowQueueMs && inflight === 0) { await stop(apiKey, `queue ${queued} <= ${settings.burstStopQueue}`); return; }
        } else state.lowSince = null;
      } else if (t >= state.cooldownUntil && queued >= settings.burstStartQueue && state.ledger.seconds < dailyCap) {
        await start(settings, apiKey);
      }
      if (t - state.lastWatchdogAt >= timing.watchdogMs) await watchdog(apiKey);
      persist();
    } finally { ticking = false; }
  }

  // ---- route side: one lease per Home-equivalent render on the pod ----
  function backend() {
    const pod = state.pod;
    if (!pod?.readyAt || !pod.health || now() - (pod.lastHealthyAt || 0) > timing.unhealthyMs) return null;
    return { endpoint: pod.endpoint, token: pod.token, slots: pod.health.slots, inflight, id: pod.id };
  }
  function acquire() {
    const b = backend();
    if (!b || inflight >= b.slots) return null;
    inflight++;
    let open = true;
    return { endpoint: b.endpoint, token: b.token, id: b.id, release() { if (open) { open = false; inflight = Math.max(0, inflight - 1); } } };
  }
  const status = () => ({ pod: state.pod && { id: state.pod.id, cloudType: state.pod.cloudType, gpu: state.pod.gpu, costPerHr: state.pod.costPerHr,
      createdAt: new Date(state.pod.createdAt).toISOString(), ready: Boolean(state.pod.readyAt), health: state.pod.health, incompatible: state.pod.incompatible || null },
    inflight, queued: state.queued ?? null, ledger: { ...state.ledger, cents: Math.round(state.ledger.cents * 100) / 100 },
    cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null, lastError: state.lastError, events: events.slice(-12),
    gpus: catalog.types.filter(t => (t.memoryInGb || 0) >= 8 && ((t.communityCloud && t.communityPrice > 0) || (t.secureCloud && t.securePrice > 0)))
      .map(t => ({ id: t.id, name: t.displayName || t.id, memoryInGb: t.memoryInGb || null,
        price: Math.min(...[t.communityCloud && t.communityPrice > 0 ? t.communityPrice : Infinity, t.secureCloud && t.securePrice > 0 ? t.securePrice : Infinity]) }))
      .sort((a, b) => b.price - a.price) });

  return {
    tick, backend, acquire, status,
    start() { if (!timer) { timer = setInterval(() => { void tick().catch(error => note('tick failed', { reason: String(error?.message || error) })); }, timing.tickMs); timer.unref?.(); } return this; },
    stopTimer() { if (timer) clearInterval(timer); timer = null; },
    _state: () => state,
  };
}

// Server wiring (custom.mjs at boot, or a hot install): runtime files, scheduler lane, worker source.
const STATE_PATH = '/data/runtime/vf-burst.json', KEY_PATH = '/data/runtime/runpod-api-key';
const BUNDLE = Object.freeze(['pod-worker.mjs', 'boot.sh', 'siglip/pod_siglip.py', 'siglip/service.py', 'siglip/pc_transfer_limits.py', 'siglip/pc_transfer_runtime.py']);
function createDefaultBurst({ here, fs = require('node:fs'), path = require('node:path'), env = process.env, log = message => console.log(message) } = {}) {
  if (typeof here !== 'string') throw new TypeError('here (directory of pod-worker.mjs) required');
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  let hyperframes = 'unknown';
  try { hyperframes = require('node:module').createRequire('/app/render/frameshift/lib/render.js')('hyperframes/package.json').version; } catch { /* pods stay unused */ }
  return createBurstController({
    readSettings: () => readJson(env.VF_PC_BOOST_CONFIG || '/data/runtime/pc-boost.json'),
    readApiKey: () => { try { return fs.readFileSync(KEY_PATH, 'utf8').trim(); } catch { return ''; } },
    queueLength: () => { const lane = globalThis.__vfSchedulerLane?.('render'); return lane ? lane.waiters.filter(w => w.resourceKey === 'frameshift').length : 0; },
    bundleFiles: () => Object.fromEntries(BUNDLE.map(name => [name, fs.readFileSync(path.join(here, ...name.split('/')))])),
    loadState: () => readJson(STATE_PATH),
    saveState: state => { const tmp = `${STATE_PATH}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, STATE_PATH); },
    log, localRuntime: { hyperframes, node: process.version } });
}

module.exports = { createBurstController, createDefaultBurst, workerEnvelope, bundleScript, STOCK_IMAGE, NAME_PREFIX, TIMING, PORT, BUNDLE };
