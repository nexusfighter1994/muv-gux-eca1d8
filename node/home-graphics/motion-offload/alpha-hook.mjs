import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {KIND, MAX_RESPONSE, MAX_OUTPUT, MAX_ARTIFACT, validate, verify, hash, payloadSha256, decodeBase64} from './alpha-worker.mjs';
import remoteActive from '../remote-active.cjs';

// An unconfirmed remote cancel pauses Home offers for a while only (Home's single slot
// rejects new work while an abandoned job could still run).
export const QUARANTINE_MS = 5 * 60 * 1000;
const uncertainHome = {until: new Map(),
  has(key) { const t = this.until.get(key); if (t == null) return false; if (Date.now() >= t) { this.until.delete(key); return false; } return true; },
  add(key) { this.until.set(key, Date.now() + QUARANTINE_MS); }};
const supported = new Set(['compositionHtml', 'renderOnlyHtml', 'assets', 'fps', 'resolution', 'workers',
  'quality', 'format', 'timeoutMs', 'targetPath', 'workDir', 'signal', 'onProgress', 'onStatus']);

function eligible(o, kind, duration) {
  return kind === KIND && o.format === 'mov' && o.fps === 24 && o.resolution === '1920x1080'
    && Number.isInteger(o.workers ?? 1) && (o.workers ?? 1) >= 1 && (o.workers ?? 1) <= 3
    && ['draft', 'standard', 'high'].includes(o.quality ?? 'standard')
    && Number.isFinite(duration) && duration > 0 && duration <= 15
    && typeof o.targetPath === 'string' && typeof o.workDir === 'string'
    && Object.keys(o).every(k => supported.has(k))
    && Array.isArray(o.assets ?? []) && (o.assets ?? []).every(a => a && typeof a.localPath === 'string'
      && Object.keys(a).every(k => ['filename', 'localPath'].includes(k)));
}

async function readJson(response, maximum, signal) {
  if (!response.ok || !response.body) throw Error('Home unavailable');
  if (Number(response.headers.get('content-length')) > maximum) throw Error('response size');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    signal?.throwIfAborted();
    for (;;) {
      const {done, value} = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > maximum) throw Error('response size');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Home rejects deadlines above 10 min; a share beyond the deadline still leaves time to receive.
export const HOME_LIMIT_MS = 600000, RECEIVE_MIN_MS = 120000, HOME_SHARE_MIN = 0.5, HOME_SHARE_MAX = 2;

export function createAlphaHook(nativeRender, {endpoint, token, contract, permitted, ffprobe, ffmpeg,
  timeoutMs = 600000, fetchImpl = fetch, requiredBackend = 'software/cpu',
  nativeReserveMs = 0, nativeReserveRatio = 0, healthTimeoutMs = null, freshNativeBudget = false, homeShare = null}) {
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || !(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || (base.hostname === '10.0.3.1' && base.port === '18191'))) throw Error('private tunnel required');
  if (requiredBackend !== 'software/cpu' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000
    || typeof contract !== 'string' || !contract) throw Error('alpha hook contract');
  const homeKey = base.origin + '|' + contract;
  return async function(options, {kind, duration, signal: outerSignal} = {}) {
    const signals = [outerSignal, options.signal].filter(Boolean);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const active = async () => {
      signal?.throwIfAborted();
      if (!await permitted?.()) throw Object.assign(Error('render scope superseded; no native fallback'), {noFallback: true});
      signal?.throwIfAborted();
    };
    await active();
    if (!eligible(options, kind, duration)) return nativeRender(options);
    const budget = Math.min(timeoutMs, options.timeoutMs ?? 600000);
    if (!Number.isInteger(budget) || budget < 1) return nativeRender(options);
    const deadline = Date.now() + budget;
    const baseReserve = Math.min(30000, budget / 3);
    const fixedReserve = Number.isFinite(nativeReserveMs) && nativeReserveMs > baseReserve
      ? Math.min(Math.max(0, budget - 1), nativeReserveMs) : baseReserve;
    const ratioReserve = Number.isFinite(nativeReserveRatio) && nativeReserveRatio > 0 && nativeReserveRatio < 1
      ? Math.min(Math.max(0, budget - 1), Math.ceil(budget * nativeReserveRatio)) : 0;
    const reserve = Math.max(fixedReserve, ratioReserve);
    // homeShare (PC Boost motionHomeShare): Home may use this share of the deadline, also
    // beyond it (capped at Home's own limit); the native fallback keeps its full deadline.
    const shareMode = freshNativeBudget && Number.isFinite(homeShare) && homeShare >= HOME_SHARE_MIN && homeShare <= HOME_SHARE_MAX;
    const homeMs = shareMode ? Math.min(HOME_LIMIT_MS, Math.ceil(budget * homeShare)) : budget - reserve;
    const homeDeadline = Date.now() + homeMs;
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(Error('alpha motion timeout')), homeMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const id = crypto.randomBytes(16).toString('hex');
    const headers = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'};
    const part = options.targetPath + '.alpha-' + id + '.part';
    let possibleRemote = false, endRemote = null;
    try {
      if (uncertainHome.has(homeKey)) throw Error('Home quarantined pending owned-job cleanup');
      const assets = [];
      let total = 0;
      for (const a of options.assets ?? []) {
        controller.signal.throwIfAborted();
        const stat = await fs.stat(a.localPath);
        if (!stat.isFile() || stat.size > MAX_ARTIFACT - total) throw Error('input size');
        const bytes = await fs.readFile(a.localPath, {signal: controller.signal});
        total += bytes.length;
        if (total > MAX_ARTIFACT) throw Error('input size');
        assets.push({filename: a.filename, sha256: hash(bytes), data: bytes.toString('base64')});
      }
      const healthSignal = Number.isFinite(healthTimeoutMs) && healthTimeoutMs > 0
        ? AbortSignal.any([controller.signal, AbortSignal.timeout(Math.ceil(healthTimeoutMs))]) : controller.signal;
      const health = await readJson(await fetchImpl(new URL('/motion/health', base), {headers, signal: healthSignal}), 16384, healthSignal);
      if (health.version !== 1 || health.contract !== contract || !Number.isInteger(health.slots) || health.slots < 1
        || !Array.isArray(health.kinds) || !health.kinds.includes(KIND)) throw Error('alpha health contract');
      await active();
      controller.signal.throwIfAborted();
      const remaining = Math.floor(homeDeadline - Date.now());
      if (remaining < 1) throw Error('remote deadline exhausted');
      const p = validate({version: 1, id, contract, kind: KIND, format: options.format,
        compositionHtml: options.compositionHtml, renderOnlyHtml: options.renderOnlyHtml ?? '', assets,
        fps: options.fps, resolution: options.resolution, workers: options.workers ?? 1, sourceWorkers: options.workers ?? 1,
        quality: options.quality ?? 'standard', duration, timeoutMs: remaining}, contract);
      possibleRemote = true;
      endRemote = remoteActive.begin('frameshift');
      const response = await fetchImpl(new URL('/motion/render', base), {
        method: 'POST', headers, body: JSON.stringify(p), signal: controller.signal,
      });
      // Home has rendered: receiving and verifying its result may use the whole budget
      // (a loaded server took >50 s here and discarded finished GPU work). The native
      // fallback keeps its own fresh budget, so this never shortens a server render.
      if (response.ok && freshNativeBudget) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(Error('alpha receive timeout')),
          Math.max(shareMode ? RECEIVE_MIN_MS : 1, deadline - Date.now()));
      }
      const result = await readJson(response, MAX_RESPONSE, controller.signal);
      const bytes = decodeBase64(result.data, MAX_OUTPUT);
      if (result.version !== 1 || result.id !== id || result.contract !== contract || result.kind !== KIND
        || result.format !== 'mov' || result.backend !== requiredBackend || !bytes.length
        || result.payloadSha256 !== payloadSha256(p) || !/^[a-f0-9]{64}$/.test(result.sha256)
        || hash(bytes) !== result.sha256) throw Error('alpha receipt mismatch');
      controller.signal.throwIfAborted();
      await fs.writeFile(part, bytes, {flag: 'wx', signal: controller.signal});
      const probe = await verify(part, p, ffprobe, ffmpeg, controller.signal);
      if (!isDeepStrictEqual(result.probe, probe)) throw Error('alpha receipt probe mismatch');
      controller.signal.throwIfAborted();
      await active();
      const artifactsDir = path.join(options.workDir, 'artifacts');
      await fs.mkdir(artifactsDir, {recursive: true});
      await fs.writeFile(path.join(artifactsDir, 'home-alpha-receipt.json'), JSON.stringify({
        version: 1, id, contract, kind: KIND, format: 'mov', sha256: result.sha256,
        payloadSha256: result.payloadSha256, backend: result.backend, probe,
      }), {signal: controller.signal});
      await active();
      controller.signal.throwIfAborted();
      await fs.rename(part, options.targetPath);
      return {videoPath: options.targetPath, width: probe.width, height: probe.height, duration: probe.duration, artifactsDir};
    } catch (error) {
      controller.abort(error);
      if (possibleRemote) {
        let ack;
        try {
          const cleanupSignal = AbortSignal.timeout(12000);
          ack = await readJson(await fetchImpl(new URL('/motion/' + id, base), {
            method: 'DELETE', headers, signal: cleanupSignal,
          }), 16384, cleanupSignal);
        } catch { /* Uncertain ownership must quarantine subsequent remote attempts. */ }
        if (ack?.terminated !== true) uncertainHome.add(homeKey);
      }
      // Native recovery below uses server CPU again: release the extra slot first.
      endRemote?.();
      await fs.rm(part, {force: true});
      if (error.noFallback) throw error;
      await active();
      // freshNativeBudget: a lost or slow Home attempt must never shorten the server render.
      const remaining = freshNativeBudget ? (options.timeoutMs ?? budget) : Math.floor(deadline - Date.now());
      if (remaining <= 0) throw Error('native outer budget exhausted');
      clearTimeout(timer);
      return await nativeRender({...options, timeoutMs: remaining});
    } finally {
      endRemote?.();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await fs.rm(part, {force: true});
    }
  };
}
