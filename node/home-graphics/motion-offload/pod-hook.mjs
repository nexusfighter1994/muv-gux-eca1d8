// Server side of a RunPod burst render (node/runpod/pod-worker.mjs): submit the exact native
// render request, poll (the RunPod proxy closes requests after 100 s), fetch the bytes, verify
// them with the same contract checks as Home results, publish atomically. Any failure renders
// natively with the full original deadline; the pod job is cancelled best effort.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {verify as verifyOpaque} from './worker.mjs';
import {verify as verifyAlpha, MAX_OUTPUT} from './alpha-worker.mjs';
import remoteActive from '../remote-active.cjs';

export const MAX_ASSETS = 32 * 1024 * 1024, POD_LIMIT_MS = 600000, RECEIVE_MS = 120000, SHARE_MIN = 0.5, SHARE_MAX = 2;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const endpointOk = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^[a-z0-9]+-\d+\.proxy\.runpod\.net$/.test(url.hostname) && url.pathname === '/' && !url.username && !url.search
      || (url.protocol === 'http:' && url.hostname === '127.0.0.1');
  } catch { return false; }
};

export function createPodHook(nativeRender, {lease, kind, permitted, ffprobe = 'ffprobe', ffmpeg = 'ffmpeg', fetchImpl = fetch,
  homeShare = null, nativeReserveRatio = 0.3, pollMs = 2000, timeoutMs = 600000}) {
  if (!lease || !endpointOk(lease.endpoint) || !/^[a-f0-9]{64}$/.test(lease.token || '')) throw Error('pod lease required');
  if (!['alpha', 'opaque'].includes(kind)) throw Error('pod kind');
  const base = lease.endpoint.replace(/\/$/, ''), headers = {Authorization: 'Bearer ' + lease.token};
  return async function(options, {duration, signal} = {}) {
    if (signal?.aborted) throw signal.reason;
    if (!await permitted?.()) throw Object.assign(Error('render scope superseded; no native fallback'), {noFallback: true});
    const format = kind === 'alpha' ? 'mov' : 'mp4', workers = options.workers ?? 1;
    const budget = Math.min(timeoutMs, options.timeoutMs ?? 600000);
    if (!Number.isInteger(budget) || budget < 1 || !(Number.isFinite(duration) && duration > 0 && duration <= 15)) return nativeRender(options);
    const share = Number.isFinite(homeShare) && homeShare >= SHARE_MIN && homeShare <= SHARE_MAX ? homeShare : 1 - nativeReserveRatio;
    const podMs = Math.max(1, Math.min(POD_LIMIT_MS, Math.ceil(budget * share)));
    const started = Date.now(), podDeadline = started + podMs, receiveDeadline = podDeadline + RECEIVE_MS;
    const id = crypto.randomBytes(16).toString('hex'), part = options.targetPath + '.pod-' + id + '.part';
    let submitted = false, endRemote = null;
    const live = () => { if (signal?.aborted) throw signal.reason; };
    try {
      const assets = [];
      let total = 0;
      for (const a of options.assets ?? []) {
        const bytes = await fs.readFile(a.localPath);
        total += bytes.length;
        if (total > MAX_ASSETS) throw Error('input size');
        assets.push({filename: a.filename, sha256: hash(bytes), data: bytes.toString('base64')});
      }
      const body = JSON.stringify({id, kind, format, compositionHtml: options.compositionHtml, renderOnlyHtml: options.renderOnlyHtml ?? '', assets,
        fps: options.fps, resolution: options.resolution, workers, quality: options.quality ?? 'standard', duration, timeoutMs: podMs});
      live();
      const created = await fetchImpl(base + '/jobs', {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body, signal: AbortSignal.timeout(90000)});
      if (created.status !== 202) throw Error('pod refused: HTTP ' + created.status);
      submitted = true;
      endRemote = remoteActive.begin('frameshift');
      let state;
      for (;;) {
        live();
        if (Date.now() > podDeadline + 5000) throw Error('pod deadline');
        await new Promise(r => setTimeout(r, pollMs));
        const response = await fetchImpl(base + '/jobs/' + id, {headers, signal: AbortSignal.timeout(20000)}).catch(() => null);
        if (!response) continue;
        if (!response.ok) throw Error('pod status HTTP ' + response.status);
        state = await response.json();
        if (state.state === 'done') break;
        if (state.state === 'failed' || state.state === 'cancelled') throw Error('pod render ' + state.state + ': ' + String(state.error || '').slice(0, 300));
      }
      if (!/^[a-f0-9]{64}$/.test(state.sha256 || '') || !Number.isInteger(state.size) || state.size < 1 || state.size > MAX_OUTPUT) throw Error('pod result size');
      const remaining = Math.max(1000, Math.min(95000, receiveDeadline - Date.now()));
      const result = await fetchImpl(base + '/jobs/' + id + '/result', {headers, signal: AbortSignal.timeout(remaining)});
      if (!result.ok) throw Error('pod result HTTP ' + result.status);
      const bytes = Buffer.from(await result.arrayBuffer());
      if (bytes.length !== state.size || hash(bytes) !== state.sha256 || result.headers.get('x-sha256') !== state.sha256) throw Error('pod result mismatch');
      live();
      await fs.writeFile(part, bytes, {flag: 'wx'});
      const probe = kind === 'alpha' ? await verifyAlpha(part, {duration, fps: 24}, ffprobe, ffmpeg, signal)
        : await verifyOpaque(part, {duration}, ffprobe, ffmpeg, signal);
      live();
      if (!await permitted()) throw Object.assign(Error('render scope superseded'), {noFallback: true});
      const artifactsDir = path.join(options.workDir, 'artifacts');
      await fs.mkdir(artifactsDir, {recursive: true});
      await fs.writeFile(path.join(artifactsDir, 'pod-receipt.json'), JSON.stringify({version: 1, id, kind, format, sha256: state.sha256, pod: lease.id, ms: Date.now() - started}));
      await fs.rename(part, options.targetPath);
      const width = probe.width, height = probe.height;
      return {videoPath: options.targetPath, width, height, duration: Number(probe.duration), artifactsDir};
    } catch (error) {
      if (submitted) { try { await fetchImpl(base + '/jobs/' + id, {method: 'DELETE', headers, signal: AbortSignal.timeout(12000)}); } catch { /* best effort */ } }
      endRemote?.(); endRemote = null;
      await fs.rm(part, {force: true});
      if (error?.noFallback || signal?.aborted) throw error;
      if (!await permitted?.()) throw Object.assign(Error('render scope superseded; no native fallback'), {noFallback: true});
      return nativeRender({...options, timeoutMs: options.timeoutMs ?? budget});
    } finally {
      endRemote?.();
      await fs.rm(part, {force: true});
    }
  };
}
