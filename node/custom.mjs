// VidForge Custom layer (server side). Loaded by the stock bundle through one import; everything else
// is reached through thin hooks installed by apply.py. Missing required hooks fail the build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installPcBoost } from './pc-boost-api.mjs';
import { installTransferControls, readTransferRuntime } from './pc-transfer-api.mjs';
import { mapAdmissionStats } from './map-admission.mjs';
import { ffmpegAdmissionStats } from './ffmpeg-admission.mjs';
import { chunkStallMs } from './chunk-stall.mjs';
import { installModControls, modEnabled } from './mod-controls.mjs';
import { customPage } from './custom-page.mjs';
import { installMotionOffload } from './home-graphics/motion-offload/server-integration.mjs';
import { installMapOffload } from './home-graphics/map-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../../public');
export const VERSION = 'vf-custom 1';
import { extendSourcingBudget as _extendSourcingBudget } from './sourcing-deadline.mjs';
import { createThumbnailOpenluxHooks as _createThumbnailOpenluxHooks } from './thumbnail-openlux.mjs';
import thumbnailSubjectIdentity from './thumbnail-subject-identity.cjs';
import longAssembly from './long-assembly.cjs';
import finalHash from './final-hash.cjs';
import renderMemoryFairness from './render-memory-fairness.cjs';
import schedulerHotpath from './scheduler-hotpath.cjs';
import homeRemote from './home-graphics/remote-active.cjs';
import runpodBurst from './runpod/burst-controller.cjs';
import jobPriority from './job-priority.cjs';
import fflowResubmit from './fflow-resubmit.cjs';
import brollReuse from './broll-reuse.cjs';
import spawnProxy from './spawn-proxy.cjs';
import procScan from './proc-scan-cache.cjs';
import frameshiftRoute from './home-graphics/motion-offload/frameshift-route.cjs';
import { getMotionConfiguration } from './home-graphics/motion-offload/binding.mjs';
export { fishFreeModel, fishFreeAvailable } from './fish-free.mjs';
import { createCompatibleConcat as _createCompatibleConcat } from './stream-compat.mjs';
import { wrapMapAdmissionCheck as _wrapMapAdmissionCheck, wrapMapWaiterChoice as _wrapMapWaiterChoice } from './map-admission.mjs';
import { wrapFfmpegAdmissionCheck as _wrapFfmpegAdmissionCheck } from './ffmpeg-admission.mjs';
import { installGpuRenderEvents as _installGpuRenderEvents } from './gpu-render-events.mjs';
import { installHomeAdmission as _installHomeAdmission, wrapHomeFflowClient as _wrapHomeFflowClient, wrapHomeRamEstimate as _wrapHomeRamEstimate } from './home-queue.mjs';
export { withoutHomeFfmpegLane } from './home-queue.mjs';
import { installHomeLibraryTrim as _installHomeLibraryTrim } from './home-library-trim.mjs';
import { installHomeSiglipStartup as _installHomeSiglipStartup } from './home-siglip.mjs';
import { wrapHomeNormalizeExec as _wrapHomeNormalizeExec } from './home-normalize.mjs';
export { nativeNormalizeRequest, canHomeNormalizeFilter } from './home-normalize.mjs';
import { installHomeDirect as _installHomeDirect } from './home-direct.mjs';
export { modEnabled };
export function createThumbnailSubjectHooks(builders) {
  const enabled = modEnabled('thumbnailIdentity');
  if (enabled) thumbnailSubjectIdentity.validateTemplates(builders);
  return thumbnailSubjectIdentity.createThumbnailSubjectHooks({ enabled,
    onError: (_kind, reason) => report('thumbnailIdentity', false, reason) });
}

export function extendSourcingBudget(original) { return modEnabled('sourcingDeadline') ? _extendSourcingBudget(original) : original; }
export function createThumbnailOpenluxHooks(options) {
  return modEnabled('thumbnailOpenlux') ? _createThumbnailOpenluxHooks(options) : { wrapCli: fn => fn, wrapGenerate: fn => fn };
}
export function createCompatibleConcat(original, options) {
  return _createCompatibleConcat(original, { ...options, convertUnsafe: modEnabled('streamCompat') });
}
export function createLongSafeJoin(original, options) {
  if (!modEnabled('streamCompat')) return original;
  const safe = longAssembly.createLongAssembly(options);
  return _createCompatibleConcat(safe.createJoin(), { ...options, key: 'chunkPaths', convertUnsafe: true });
}
export function validateLongCopy(paths, target, options) {
  return modEnabled('streamCompat') ? longAssembly.createLongAssembly({ probe: options.probe }).validate(paths, target, options) : false;
}
export function createFinalHasher(original, options) {
  return modEnabled('streamCompat') ? finalHash.createFinalHasher(original, options) : original;
}
export function wrapMapAdmissionCheck(original, ...args) { return modEnabled('mapAdmission') ? _wrapMapAdmissionCheck(original, ...args) : original; }
export function wrapMapWaiterChoice(original, ...args) { return modEnabled('mapAdmission') ? _wrapMapWaiterChoice(original, ...args) : original; }
export function createRenderFocusState(native) { return schedulerHotpath.createFocusState(native); }
// B-roll resume safety (broll-reuse-install.py): never re-search a rendered B-roll video.
export function brollFinalReuse(input) { return brollReuse.brollFinalReuse(input); }
export function stableSegmentInput(segment) { return brollReuse.stableSegmentInput(segment); }
// Main-thread relief: native ffmpeg/ffprobe execs are spawned by a small helper (spawn-proxy.cjs).
if (process.env.VF_SPAWN_PROXY !== '0') { try { spawnProxy.install(); } catch (error) { console.error('[vf-custom] spawn proxy unavailable', error); } }
export function spawnProxyStats() { return globalThis.__vfSpawnProxy?.stats ?? null; }
// Shared /proc snapshot for the native render memory sampler (proc-scan-cache-install.py).
export const procScanTable = procScan.procScanTable;
export const procScanPss = procScan.procScanPss;
// Job pages rebuild the full job snapshot (DB + ETA) per subscribed job at most this often;
// native default 1000 ms took ~13% of the busy main thread. An explicit env value wins.
process.env.VIDFORGE_PROGRESS_SNAPSHOT_MIN_MS ??= '2000';
// One Home-GPU route for every Frameshift render (alpha overlays + opaque motion), switch homeMotion.
export function installFrameshiftRoute(native) {
  if (!modEnabled('homeMotion') || globalThis.__vfFrameshiftRoute) return globalThis.__vfFrameshiftRoute || null;
  const route = frameshiftRoute.createFrameshiftRoute({ ...native, getConfig: getMotionConfiguration, setOfferable: homeRemote.setOfferable,
    loadOpaque: () => import('./home-graphics/motion-offload/hook.mjs'),
    loadAlpha: () => import('./home-graphics/motion-offload/alpha-hook.mjs') });
  installRunpodBurst();
  return (globalThis.__vfFrameshiftRoute = route);
}
// RunPod GPU burst (PC Boost settings burst*): rents one pod while many frameshift renders wait.
export function installRunpodBurst() {
  if (globalThis.__vfBurst) return globalThis.__vfBurst;
  return (globalThis.__vfBurst = runpodBurst.createDefaultBurst({ here: path.join(HERE, 'runpod') }).start());
}
// Finish-first: the further a running video is, the higher its native priority (same switch as finish-first RAM fairness).
export function installJobPriority(native) {
  if (!modEnabled('mapAdmission') || globalThis.__vfJobPriority) return globalThis.__vfJobPriority || null;
  const manager = jobPriority.createJobPriority(native);
  manager.start();
  return (globalThis.__vfJobPriority = manager);
}
export function wrapRenderMemoryGate(original, getState) { return modEnabled('mapAdmission') ? renderMemoryFairness.createRenderMemoryFairness(original, { getState }) : original; }
export function wrapFfmpegAdmissionCheck(original, ...args) { return modEnabled('ffmpegAdmission') ? _wrapFfmpegAdmissionCheck(original, ...args) : original; }
export function installGpuRenderEvents(...args) { if (modEnabled('gpuEvents')) return _installGpuRenderEvents(...args); }
const homeQueueEnabled = () => modEnabled('homeQueue') && modEnabled('homeFfmpeg');
export function installHomeAdmission(...args) { if (homeQueueEnabled()) return _installHomeAdmission(...args); }
export function wrapHomeFflowClient(original, ...args) { return homeQueueEnabled() ? _wrapHomeFflowClient(original, ...args) : original; }
export function wrapHomeRamEstimate(original, ...args) { return homeQueueEnabled() ? _wrapHomeRamEstimate(original, ...args) : original; }
export function installHomeLibraryTrim(...args) { if (homeQueueEnabled()) return _installHomeLibraryTrim(...args); }
export function installHomeDirect(...args) { if (homeQueueEnabled()) return _installHomeDirect(...args); }
export function wrapHomeNormalizeExec(original, ...args) { return homeQueueEnabled() ? _wrapHomeNormalizeExec(original, ...args) : original; }
export function installHomeSiglipStartup(...args) { if (modEnabled('homeSiglip')) return _installHomeSiglipStartup(...args); }
const runtime = {};

export function report(name, ok, detail = '') {
  runtime[name] = ok ? 'ok' : `skipped: ${detail}`;
  if (!ok) console.warn(`[vf-custom] hook ${name} skipped: ${detail}`);
}

function buildReport() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'hooks-build.json'), 'utf8')); } catch { return null; }
}

// ---- scheduler / FFlow hooks (wrapped stock functions call these) ----
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
// A graphics render running on the Home PC keeps its native lease but uses no server CPU.
export function homeRemoteActive(resource) { return homeRemote.active(resource); }
export function laneSize(lane, size) {
  if (lane === 'render' && Number.isFinite(size)) return size + homeRemote.total();
  if (!modEnabled('serverBoost')) return size;
  if (!Number.isFinite(size)) return size;
  if (lane === 'ffmpeg') return Math.max(size, num(globalThis.__vfPcFfmpegLimit)) + num(globalThis.__vfPcBoostFfmpegExtra);
  if (lane === 'clipvault' && num(globalThis.__vfPcClipvaultLimit) > 0) return Math.max(size, num(globalThis.__vfPcClipvaultLimit));
  return size;
}
export function workerTarget(value) {
  if (!modEnabled('serverBoost')) return value;
  return num(value) + num(globalThis.__vfPcBoostFfmpegExtra);
}
export function engineLimits(limits) {
  if (!modEnabled('serverBoost')) return limits;
  const boost = num(globalThis.__vfPcFfmpegLimit);
  if (!limits || typeof limits !== 'object' || boost <= 0) return limits;
  return { ...limits, ffmpeg: Math.max(num(limits.ffmpeg), boost) };
}

// ---- SigLIP on the home-PC GPU ----
// The stock SigLIP client is wrapped: POST /embed is ranked on the PC (identical model, revision,
// text preprocessing and multi-query scoring) and answered as a finished task; anything the PC
// cannot take goes to the stock engine unchanged.
const SIGLIP_MODEL = 'google/siglip2-base-patch16-384';
const SIGLIP_REVISION = 'f775b65a79762255128c981547af89addcfe0f88';
let siglipPausedUntil = 0;
const siglipStats = { pc: 0, server: 0, fallback: 0, lastSkip: null, lastError: null };
const skip = reason => { siglipStats.lastSkip = reason; return null; };
const serverTextMode = () => (/^(1|true|yes|on)$/i.test(String(process.env.VIDFORGE_SIGLIP_LEGACY_TEXT || '').trim()) ? 'legacy' : 'siglip2');

async function readLimited(response, maxBytes, signal) {
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const size = Number(response.headers.get('content-length'));
  if (size > maxBytes) throw new Error('too large');
  let total = 0; const parts = [];
  for await (const part of response.body) {
    signal?.throwIfAborted();
    total += part.byteLength;
    if (total > maxBytes) throw new Error('transfer limit');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts, total);
}

async function pcRank(body, fflow) {
  if (!modEnabled('homeSiglip')) return null;
  if (Date.now() < siglipPausedUntil) return null;
  let config, token;
  try {
    config = JSON.parse(fs.readFileSync(process.env.VF_PC_BOOST_CONFIG || '/data/runtime/pc-boost.json', 'utf8'));
    if (config.enabled !== true || config.siglipEnabled !== true) return skip('disabled');
    token = fs.readFileSync(process.env.VF_PC_BOOST_TOKEN_FILE || '/data/runtime/pc-boost-token', 'utf8').trim();
    if (token.length < 16) return skip('no token');
  } catch { return skip('no config'); }
  const url = (process.env.VF_PC_BOOST_SIGLIP_URL || 'http://10.0.3.1:18194').replace(/\/$/, '');
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const signal = controller.signal;
  try {
    const health = JSON.parse((await readLimited(await fetch(url + '/health', { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }), 16384)).toString());
    const mode = serverTextMode();
    if (!health.ready || health.model_id !== SIGLIP_MODEL || health.model_revision !== SIGLIP_REVISION
      || !Array.isArray(health.text_modes) || !health.text_modes.includes(mode) || health.multi_query !== true) return skip('pc model/version mismatch');
    const transfer = readTransferRuntime().limits;
    const imageLimit = transfer.siglipMaxImageMb * 1024 * 1024;
    const bodyLimit = Math.max(45, transfer.siglipMaxImageMb) * 1024 * 1024;
    const workerImageLimit = health.transferLimits?.siglipMaxImageMb ?? 20;
    if (!Number.isSafeInteger(workerImageLimit) || workerImageLimit < transfer.siglipMaxImageMb) return skip('pc image limits pending');
    if (Number(health.active_tasks || 0) >= Math.max(1, Math.min(25, Number(config.siglipConcurrency) || 1))) return skip('pc busy');
    const trusted = fflow?.baseUrl ? new URL(fflow.baseUrl()) : null;
    const candidates = []; let totalBytes = 0;
    for (const candidate of body.candidates) {
      if (typeof candidate?.image_url !== 'string') return skip('candidate without image_url');
      const target = new URL(candidate.image_url);
      const imageHeaders = { 'User-Agent': 'vidforge-siglip-engine/1.0' };
      if (trusted && target.origin === trusted.origin && target.pathname.startsWith('/v1/download/') && fflow.authHeaders) Object.assign(imageHeaders, fflow.authHeaders());
      const response = await fetch(candidate.image_url, { headers: imageHeaders, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      const type = response.headers.get('content-type');
      if (type && !type.toLowerCase().startsWith('image/')) throw new Error('image type');
      const bytes = await readLimited(response, imageLimit, signal);
      totalBytes += bytes.length;
      if (totalBytes > bodyLimit) throw new Error('request too large');
      candidates.push({ id: candidate.id, image_base64: bytes.toString('base64'), metadata: candidate.metadata || {} });
    }
    const request = { query: body.query, candidates, text_mode: mode };
    for (const key of ['queries', 'negative_queries', 'negative_weight']) if (body[key] !== undefined) request[key] = body[key];
    const response = await fetch(url + '/rank', { method: 'POST', headers, body: JSON.stringify(request), signal });
    const result = JSON.parse((await readLimited(response, 2 * 1024 * 1024, signal)).toString());
    const expected = new Set(body.candidates.map(c => c.id));
    if (result.status !== 'completed' || !Array.isArray(result.results) || result.results.length !== expected.size) throw new Error('incomplete: ' + JSON.stringify(result).slice(0, 200));
    for (const item of result.results) {
      if (!expected.delete(item.id) || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.error) throw new Error('invalid');
    }
    return result;
  } catch (error) {
    siglipPausedUntil = Date.now() + 3000;
    siglipStats.fallback += 1;
    siglipStats.lastError = String(error?.message || error).slice(0, 300);
    return null;
  } finally { clearTimeout(timer); }
}

export function wrapSiglip(client, fflow) {
  if (!client || typeof client.request !== 'function' || client.__vfcSiglip) return false;
  const original = client.request.bind(client);
  const finished = new Map();
  client.request = async function (pathname, options = {}) {
    if (pathname === '/embed' && String(options?.method || '').toUpperCase() === 'POST' && Array.isArray(options?.body?.candidates)) {
      const result = await pcRank(options.body, fflow).catch(() => null);
      if (result) {
        const id = 'vfpc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        finished.set(id, result);
        setTimeout(() => finished.delete(id), 600000).unref?.();
        siglipStats.pc += 1;
        return { task_id: id, status: 'queued' };
      }
      siglipStats.server += 1;
    }
    const match = /^\/embed\/(vfpc-[a-z0-9]+)$/.exec(String(pathname));
    if (match && finished.has(match[1])) return finished.get(match[1]);
    return original(pathname, options);
  };
  client.__vfcSiglip = true;
  client.__vfNativeSiglipRequest = original;
  return true;
}

// Stock clients are created lazily; install as soon as both exist.
export function installSiglip(getClient, getFflow) {
  if (!modEnabled('homeSiglip')) return;
  const tick = () => {
    try {
      const client = getClient();
      if (client && wrapSiglip(client, getFflow())) { report('siglipPc', true); clearInterval(timer); }
    } catch {}
  };
  const timer = setInterval(tick, 2000);
  timer.unref?.();
  tick();
}

// ---- Fork storm guard -----------------------------------------------------------------------------
// The server process is several GB; every child_process.spawn forks it and blocks the event loop for
// ~10-20 ms. Contact sheets spawned 1 `ffmpeg -version` probe + 9 single-frame ffmpeg runs each, with no
// limit, so b-roll scoring could starve the loop: the HTTP server stopped accepting and keep-alive
// sockets to the engines went stale ("fflow POST /v1/render: fetch failed").
//  - the ffmpeg probe is cached while it says yes
//  - one ffmpeg run extracts all frames of a sheet (bit-identical to single runs; single runs as fallback)
//  - at most SHEET_LIMIT sheet/frame-set extractions run at once
const SHEET_LIMIT = 6;
export const sheetStats = { batched: 0, fallback: 0, waits: 0 };
export function installSheetBatch(options) {
  if (!modEnabled('sheetBatch')) return;
  const { getSheet, setSheet, getProbe, setProbe, getFrames, setFrames, run, times, width, height } = options;
  let active = 0;
  const queue = [];
  const acquire = () => active < SHEET_LIMIT ? (active += 1, Promise.resolve()) : new Promise(resolve => { sheetStats.waits += 1; queue.push(resolve); });
  const release = () => { const next = queue.shift(); if (next) next(); else active -= 1; };
  const gated = fn => async function (...args) { await acquire(); try { return await fn.apply(this, args); } finally { release(); } };

  const probe = getProbe();
  let probeOk = 0;
  setProbe(async function (...args) {
    if (Date.now() - probeOk < 600000) return true;
    const ok = await probe.apply(this, args);
    if (ok) probeOk = Date.now();
    return ok;
  });

  const sheet = gated(getSheet());
  setSheet(async function (source, durationSec, options = {}) {
    if (options.extractFrame || options.runFfmpeg) return sheet.call(this, source, durationSec, options);
    const stamps = times(durationSec);
    const filter = `scale=${width()}:${height()}:force_original_aspect_ratio=decrease,pad=${width()}:${height()}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const dir = path.join(os.tmpdir(), 'vidforge-contact-sheets', `batch-${crypto.randomUUID()}`);
    let batch = null;
    const runBatch = async () => {
      fs.mkdirSync(dir, { recursive: true });
      const args = [];
      for (const ts of stamps) args.push('-ss', Number(ts).toFixed(3), '-i', source);
      stamps.forEach((_, k) => args.push('-map', `${k}:v:0`, '-frames:v', '1', '-vf', filter, '-q:v', '4', path.join(dir, `b-${k}.jpg`)));
      await run(args);
    };
    const extractFrame = async ({ timestampSec, outputPath, index }) => {
      batch ||= runBatch().then(() => { sheetStats.batched += 1; return true; }, () => { sheetStats.fallback += 1; return false; });
      if (await batch) {
        try {
          const file = path.join(dir, `b-${index}.jpg`);
          if (fs.statSync(file).size > 0) { fs.copyFileSync(file, outputPath); return; }
        } catch {}
      }
      await run(['-ss', Number(timestampSec).toFixed(3), '-i', source, '-frames:v', '1', '-vf', filter, '-q:v', '4', outputPath]);
    };
    try { return await sheet.call(this, source, durationSec, { ...options, extractFrame }); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  });
  if (getFrames && setFrames) setFrames(gated(getFrames()));
  report('sheetBatch', true);
}

// ---- Engine clients retry pure connection failures ----------------------------------------------
// A stale keep-alive socket (or a reset/refused connect) surfaces as "fetch failed" and used to fail the
// whole chunk. HTTP errors and timeouts are not retried.
const NET_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|other side closed|socket hang up|UND_ERR_SOCKET/i;
export const engineRetryStats = { retried: {}, recovered: {}, gaveUp: {} };
function wrapEngineClient(client, name) {
  if (!client || typeof client.request !== 'function' || client.__vfRetry) return Boolean(client?.__vfRetry);
  const original = client.request;
  client.request = async function (pathName, options) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await original.call(this, pathName, options);
        if (attempt > 0) engineRetryStats.recovered[name] = (engineRetryStats.recovered[name] || 0) + 1;
        return result;
      } catch (error) {
        const network = !error?.status && NET_ERROR.test(String(error?.message || ''));
        if (!network || attempt >= 2 || options?.binary === 'stream') {
          if (network && attempt > 0) engineRetryStats.gaveUp[name] = (engineRetryStats.gaveUp[name] || 0) + 1;
          throw error;
        }
        engineRetryStats.retried[name] = (engineRetryStats.retried[name] || 0) + 1;
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 250 : 1000));
      }
    }
  };
  client.__vfRetry = true;
  // A transient Home-fallback admission failure inside FFlow is resubmitted, never fails the chunk.
  if (name === 'fflow') client.request = fflowResubmit.createResubmitter(client.request);
  return true;
}
export function installEngineRetry(clients) {
  if (!modEnabled('engineRetry')) return;
  const tick = () => {
    let done = 0;
    for (const [name, get] of clients) { try { if (wrapEngineClient(get(), name)) done += 1; } catch {} }
    if (done === clients.length) { report('engineRetry', true); clearInterval(timer); }
  };
  const timer = setInterval(tick, 2000);
  timer.unref?.();
  tick();
}

// ---- Segment fallbacks: a failed custom animation becomes a b-roll image before anything else ----
// Stock (2026.10.08): custom_animation -> infographic_2d -> safe_visual. safe_visual must stay the last resort.
const FALLBACK_FIRST = { custom_animation: ['b_roll_image'] };
export function patchFallbacks(map) {
  if (!map || typeof map !== 'object') return null;
  const next = { ...map };
  for (const [type, first] of Object.entries(FALLBACK_FIRST)) {
    const chain = Array.isArray(map[type]) ? [...map[type]] : null;
    if (!chain) continue;
    const head = first.filter(t => t !== type && !chain.includes(t));
    next[type] = Object.freeze([...head, ...chain]);
  }
  return Object.freeze(next);
}
// The map is created by a lazy module initializer, so it is replaced as soon as it exists.
const patchedMaps = new WeakSet();
export function installFallbacks(get, set) {
  if (!modEnabled('fallbacks')) return;
  const tick = () => {
    try {
      const map = get();
      if (!map || patchedMaps.has(map)) return;
      const next = patchFallbacks(map);
      if (!next) return;
      patchedMaps.add(next);
      set(next);
      report('fallbacks', true);
      clearInterval(timer);
    } catch (error) { report('fallbacks', false, String(error?.message || error)); }
  };
  const timer = setInterval(tick, 1000);
  timer.unref?.();
  tick();
}

// ---- Max active videos (old VidForge behaviour: only N videos run at once, the rest waits) ----
const CUSTOM_DEFAULTS = Object.freeze({ maxActiveVideos: 15, surplusAttempts: 5, surplusIgnoreBreaker: true, surplusFirst: true, autoRetryFailed: 3, surplusRetryMinSec: 10, surplusRetryMaxSec: 20, surplusInsertEfforts: Object.freeze(['low', 'medium', 'high']) });
let customSettings = { ...CUSTOM_DEFAULTS };
let settingsDb = null;
function loadCustomSettings(db) {
  settingsDb = db;
  try {
    const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'vf_custom'").get();
    if (row) customSettings = { ...CUSTOM_DEFAULTS, ...validateCustom(JSON.parse(row.value_json)) };
  } catch {}
  globalThis.__vfMaxActiveVideos = maxActiveVideos;
}
function validateCustom(patch) {
  const next = {};
  if (patch && Object.hasOwn(patch, 'surplusAttempts')) {
    const v = patch.surplusAttempts;
    if (!Number.isInteger(v) || v < 1 || v > 10) throw Object.assign(new Error('surplusAttempts must be a whole number from 1 to 10.'), { status: 400 });
    next.surplusAttempts = v;
  }
  if (patch && Object.hasOwn(patch, 'surplusIgnoreBreaker')) {
    if (typeof patch.surplusIgnoreBreaker !== 'boolean') throw Object.assign(new Error('surplusIgnoreBreaker must be true or false.'), { status: 400 });
    next.surplusIgnoreBreaker = patch.surplusIgnoreBreaker;
  }
  if (patch && Object.hasOwn(patch, 'surplusFirst')) {
    if (typeof patch.surplusFirst !== 'boolean') throw Object.assign(new Error('surplusFirst must be true or false.'), { status: 400 });
    next.surplusFirst = patch.surplusFirst;
  }
  if (patch && Object.hasOwn(patch, 'surplusInsertEfforts')) {
    const raw = patch.surplusInsertEfforts;
    const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map(v => String(v).trim().toLowerCase()).filter(Boolean);
    const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (!list.length || list.length > 5 || list.some(v => !allowed.has(v))) throw Object.assign(new Error('surplusInsertEfforts must be 1 to 5 of: none, minimal, low, medium, high, xhigh, max (comma separated).'), { status: 400 });
    next.surplusInsertEfforts = list;
  }
  for (const k of ['surplusRetryMinSec', 'surplusRetryMaxSec']) {
    if (patch && Object.hasOwn(patch, k)) {
      const v = patch[k];
      if (!Number.isInteger(v) || v < 0 || v > 120) throw Object.assign(new Error(`${k} must be a whole number of seconds from 0 to 120.`), { status: 400 });
      next[k] = v;
    }
  }
  if (patch && Object.hasOwn(patch, 'autoRetryFailed')) {
    const v = patch.autoRetryFailed;
    if (!Number.isInteger(v) || v < 0 || v > 10) throw Object.assign(new Error('autoRetryFailed must be a whole number from 0 to 10.'), { status: 400 });
    next.autoRetryFailed = v;
  }
  if (patch && Object.hasOwn(patch, 'maxActiveVideos')) {
    const v = patch.maxActiveVideos;
    if (!Number.isInteger(v) || v < 1 || v > 200) throw Object.assign(new Error('maxActiveVideos must be a whole number from 1 to 200.'), { status: 400 });
    next.maxActiveVideos = v;
  }
  return next;
}
export function maxActiveVideos() { return modEnabled('queueLimit') ? customSettings.maxActiveVideos : 1000000; }
// ---- Surplus retries (old VidForge: Surplus is retried, not skipped after a few 503s) ----
const isSurplus = spec => (spec && typeof spec === 'object' ? spec.provider : spec) === 'surplus';
export function llmAttempts(spec, stock) {
  if (!modEnabled('surplusRetry')) return stock;
  return isSurplus(spec) ? Math.max(Number(stock) || 1, customSettings.surplusAttempts) : stock;
}
// Pause before the next Surplus attempt: a random value inside the configured window, or the
// provider's own Retry-After when that is longer (stock caps it at 60 s). Other providers keep stock.
export function retryDelay(spec, stockMs, error) {
  if (!modEnabled('surplusRetry')) return stockMs;
  if (!isSurplus(spec)) return stockMs;
  const min = customSettings.surplusRetryMinSec * 1000;
  const max = Math.max(min, customSettings.surplusRetryMaxSec * 1000);
  const ours = Math.round(min + Math.random() * (max - min));
  return error?.detail?.retryAfter ? Math.max(ours, Number(stockMs) || 0) : ours;
}
export function breakerAllows(spec, stockAllows) {
  if (!modEnabled('surplusRetry')) return stockAllows;
  return stockAllows || (isSurplus(spec) && customSettings.surplusIgnoreBreaker === true);
}
// Text/vision chains with a fixed route put cli-proxy first; move Surplus to the front instead
// (keeps the route's effort). Routes whose built-in chain has no Surplus at all (frame/image
// scorers, overlay locators: cli-proxy -> OpenRouter) get a Surplus leg in front, using the
// Surplus model from Settings -> Routing. User pins, video inputs and the special scorers that
// stock keeps on their own models stay untouched.
const SURPLUS_INSERT_SKIP = new Set(['brollSegmentScorer', 'brollSegmentScorerAntigravity', 'imageScorer', 'assetPartLocator', 'thumbnailBlueprintAnalyzer', 'thumbnailValidator']);
let routingModelsCache = { at: 0, value: null };
function surplusRouting(pipeline) {
  if (Date.now() - routingModelsCache.at > 30000) {
    let value = null;
    try { value = JSON.parse(settingsDb.prepare("SELECT value_json FROM app_settings WHERE key = 'general'").get()?.value_json || '{}')?.routingModels || null; } catch {}
    routingModelsCache = { at: Date.now(), value };
  }
  const entry = routingModelsCache.value?.[pipeline === 'vision' ? 'vision' : 'scripts']?.surplus;
  return entry && typeof entry === 'object' ? entry : null;
}
export const surplusFirstStats = { moved: 0, kept: 0, inserted: 0 };
export function surplusFirst(chain, route, video, pipeline) {
  if (!modEnabled('surplusRouting')) return chain;
  try {
    if (customSettings.surplusFirst !== true || video || !Array.isArray(chain) || chain.length < 1) return chain;
    const at = chain.findIndex(isSurplus);
    if (at < 0) {
      if (SURPLUS_INSERT_SKIP.has(route) || chain.some(s => s?.provider === 'openaiChatgpt' && chain.length === 1)) return chain;
      const routing = surplusRouting(pipeline);
      const efforts = customSettings.surplusInsertEfforts?.length ? customSettings.surplusInsertEfforts : [routing?.effort || chain[0]?.effort || 'medium'];
      const legs = efforts.map(effort => ({
        provider: 'surplus', id: 'surplus', model: routing?.model || 'gpt-5.6-luna', effort, effortOverridden: true,
        ...(routing?.model ? { modelOverridden: true } : {}),
      }));
      surplusFirstStats.inserted += 1;
      return [...legs, ...chain];
    }
    if (at === 0) { surplusFirstStats.kept += 1; return chain; }
    const lead = chain[0];
    const leg = { ...chain[at] };
    if (lead?.effort && !leg.modelOverridden) leg.effort = lead.effort;
    surplusFirstStats.moved += 1;
    return [leg, ...chain.slice(0, at), ...chain.slice(at + 1)];
  } catch { return chain; }
}
// The Surplus market check shares one cached promise between all Surplus calls. When that fetch
// never settles, every Surplus call (and every b-roll step holding an llm slot around it) waits
// forever. Bound it: after 20 s drop the stuck entry and fail open, exactly like stock does on errors.
const MARKET_TIMEOUT_MS = 20000;
const MARKET_RETRY_MS = 15000;
export const marketGuardStats = { timeouts: 0, lastAt: null };
export function wrapMarketCheck(original, getCache) {
  if (!modEnabled('marketGuard')) return original;
  const flights = new Map();
  const backoffs = new Map();
  const guarded = function (opts) {
    const model = opts?.model ?? 'gpt-5.6-luna';
    const backoff = backoffs.get(model);
    if (backoff && backoff.until > Date.now()) return Promise.resolve(backoff.value);
    backoffs.delete(model);
    if (flights.has(model)) return flights.get(model);
    let nativeEntry = null;
    const call = Promise.resolve().then(() => {
      const result = original.apply(this, arguments);
      try { nativeEntry = getCache()?.get(model); } catch {}
      return result;
    });
    let timer = null;
    const limit = new Promise(resolve => {
      timer = setTimeout(() => {
        marketGuardStats.timeouts += 1;
        marketGuardStats.lastAt = new Date().toISOString();
        const value = { eligible: true, reason: 'market_unavailable_fail_open', price: null, errorCode: 'vf_custom_timeout' };
        let superseded = false;
        try {
          const cache = getCache();
          const current = cache?.get(model);
          superseded = current != null && current !== nativeEntry;
          if (current === nativeEntry && current?.promise) cache.delete(model);
        } catch {}
        if (!superseded) backoffs.set(model, { until: Date.now() + MARKET_RETRY_MS, value });
        console.warn('[vf-custom] Surplus market check timed out; allowing Surplus (fail-open)');
        resolve(value);
      }, MARKET_TIMEOUT_MS);
      timer.unref?.();
    });
    const flight = Promise.race([call, limit]).finally(() => {
      clearTimeout(timer);
      if (flights.get(model) === flight) flights.delete(model);
    });
    flights.set(model, flight);
    return flight;
  };
  Object.defineProperties(guarded, {
    originalMarketCheck: { value: original },
    marketGuardVersion: { value: 'singleflight-v2' },
  });
  return guarded;
}

// A chunk composition sometimes finds one of its freshly staged inputs (e.g. inputs/hit_<uuid>.wav)
// already gone when FFlow starts. Re-stage and resubmit the composition instead of failing the chunk.
const STAGED_MISSING = /Source file not found: inputs\//;
export const restageStats = { retried: 0, recovered: 0, last: null };
export function wrapComposition(original) {
  if (!modEnabled('restage')) return original;
  return async function (args) {
    let current = args;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await original.call(this, current);
        if (attempt > 0) restageStats.recovered += 1;
        return result;
      } catch (error) {
        if (attempt >= 2 || !STAGED_MISSING.test(String(error?.message || error))) throw error;
        restageStats.retried += 1;
        restageStats.last = { chunk: current?.chunkId || null, error: String(error?.message || error).slice(0, 200), at: new Date().toISOString() };
        console.warn(`[vf-custom] chunk ${current?.chunkId || '?'}: staged input vanished; re-staging and resubmitting (${attempt + 1}/2)`);
        const checkpoint = current?.checkpoint;
        current = { ...current, checkpoint: checkpoint && { ...checkpoint, remoteTask: null } };
      }
    }
  };
}

// ---- Auto retry: a failed video is retried (stock "Retry", resumes saved work) before it stays failed ----
export const autoRetryStats = { retried: 0, last: null };
let retryJob = null;
let retryTimer = null;
const RETRY_DELAY_MS = 90 * 1000;
const RETRY_WINDOW_MS = 6 * 3600 * 1000;
function retryCounts() {
  try { return JSON.parse(settingsDb.prepare("SELECT value_json FROM app_settings WHERE key = 'vf_custom_autoretry'").get()?.value_json || '{}') || {}; }
  catch { return {}; }
}
function saveRetryCounts(counts) {
  const live = new Set(settingsDb.prepare("SELECT id FROM queue_jobs WHERE status IN ('queued','running','pausing','paused','failed')").all().map(r => r.id));
  const kept = Object.fromEntries(Object.entries(counts).filter(([id]) => live.has(id)));
  settingsDb.prepare("INSERT INTO app_settings (key, value_json) VALUES ('vf_custom_autoretry', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(kept));
}
async function autoRetryTick() {
  if (!modEnabled('autoRetry')) return;
  const limit = customSettings.autoRetryFailed;
  if (!retryJob || !settingsDb || !(limit > 0)) return;
  const since = new Date(Date.now() - RETRY_WINDOW_MS).toISOString();
  const rows = settingsDb.prepare("SELECT id, updated_at FROM queue_jobs WHERE status = 'failed' AND updated_at >= ? ORDER BY updated_at ASC").all(since);
  if (!rows.length) return;
  const counts = retryCounts();
  for (const row of rows) {
    const used = Number(counts[row.id]) || 0;
    if (used >= limit) continue;
    if (Date.now() - Date.parse(row.updated_at) < RETRY_DELAY_MS) continue;
    counts[row.id] = used + 1;
    saveRetryCounts(counts);
    try {
      const result = await retryJob(row.id);
      if (result?.ok === false) throw new Error(result.error || `status ${result.status}`);
      autoRetryStats.retried += 1;
      autoRetryStats.last = { job: row.id, attempt: used + 1, of: limit, at: new Date().toISOString() };
      console.log(`[vf-custom] auto retry ${used + 1}/${limit} for failed video ${row.id}`);
    } catch (error) {
      console.error(`[vf-custom] auto retry for ${row.id} failed`, error?.message || error);
    }
  }
}
export function installAutoRetry(fn) {
  if (!modEnabled('autoRetry')) return;
  retryJob = fn;
  if (!retryTimer) {
    retryTimer = setInterval(() => { autoRetryTick().catch(error => console.error('[vf-custom] auto retry tick failed', error)); }, 60 * 1000);
    retryTimer.unref?.();
  }
  report('autoRetry', true);
}

// Called by the stock "resume after restart" pass before it restarts running videos.
export function demoteOverflow(db) {
  if (!modEnabled('queueLimit')) return;
  try {
    const limit = maxActiveVideos();
    const rows = db.prepare("SELECT id FROM queue_jobs WHERE status IN ('running','pausing') ORDER BY queued_at ASC, created_at ASC, id ASC").all();
    const overflow = rows.slice(limit);
    if (!overflow.length) return;
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const row of overflow) {
        const changed = db.prepare("UPDATE queue_jobs SET status = 'queued', started_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'").run(now, row.id).changes;
        if (changed) db.prepare("UPDATE pipeline_jobs SET stage = 'queued', stage_detail = ?, updated_at = ? WHERE job_id = ? AND stage NOT IN ('completed','failed','canceled','expired')")
          .run(`Waiting for an active video slot (max ${limit} at once)`, now, row.id);
      }
    })();
    console.log(`[vf-custom] ${overflow.length} video(s) back to the queue; at most ${limit} run at once`);
  } catch (error) { console.error('[vf-custom] demoteOverflow failed', error); }
}

// ---- Custom page (/custom): own HTML with VidForge's stylesheet, owner only ----
function vidforgeStyles() {
  try {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    return [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(m => m[0]).join('\n');
  } catch { return ''; }
}
export function installCustom({ app, db, requireOwner, runtimePath }) {
  installModControls({ app, db, requireOwner, runtimePath });
  const motion = installMotionOffload({modEnabled});
  report('homeMotion',motion.installed,motion.reason||'');
  try { installMapOffload({modEnabled}); report('homeMap',true); }
  catch(error) { report('homeMap',false,String(error.message)); }
  if (modEnabled('chunkWatchdog')) process.env.VIDFORGE_CHUNK_RENDER_STALL_MS = String(chunkStallMs(process.env.VIDFORGE_CHUNK_RENDER_STALL_MS));
  globalThis.__vfCustomApp = app;
  globalThis.__vfCustomOwner = requireOwner;
  loadCustomSettings(db);
  app.get('/api/vf-custom/settings', requireOwner, (_req, res) => res.json({ settings: customSettings, defaults: CUSTOM_DEFAULTS }));
  app.patch('/api/vf-custom/settings', requireOwner, (req, res) => {
    try {
      const next = { ...customSettings, ...validateCustom(req.body || {}) };
      db.prepare("INSERT INTO app_settings (key, value_json) VALUES ('vf_custom', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(next));
      customSettings = next;
      try { globalThis.__vfDispatchQueued?.(); } catch {}
      res.json({ settings: customSettings, defaults: CUSTOM_DEFAULTS });
    } catch (error) { res.status(error.status || 500).json({ error: String(error.message || error) }); }
  });
  try { installPcBoost({ app, db, requireOwner }); report('pcBoostApi', true); }
  catch (error) { report('pcBoostApi', false, String(error?.message || error)); }
  try { installTransferControls({ app, db, requireOwner }); report('pcTransferApi', true); }
  catch (error) { report('pcTransferApi', false, String(error?.message || error)); }
  app.get('/api/vf-custom/status', requireOwner, (_req, res) => {
    res.json({ version: VERSION, build: buildReport(), runtime,
      boost: { ffmpeg: num(globalThis.__vfPcFfmpegLimit), clipvault: num(globalThis.__vfPcClipvaultLimit),
        ffmpegExtra: num(globalThis.__vfPcBoostFfmpegExtra), pcActive: num(globalThis.__vfPcBoostActive) },
      siglip: { ...siglipStats, textMode: serverTextMode() }, surplusFirst: { ...surplusFirstStats },
      marketGuard: { ...marketGuardStats }, mapAdmission: { ...mapAdmissionStats },
      ffmpegAdmission: { ...ffmpegAdmissionStats },
      autoRetry: { ...autoRetryStats }, restage: { ...restageStats },
      sheets: { ...sheetStats }, engineRetry: engineRetryStats });
  });
  // Page shell is public HTML (no data); every API it calls is owner-only.
  app.get(['/custom', '/settings/custom'], (_req, res) => res.type('html').send(customPage(vidforgeStyles())));
  report('customPage', true);
}
