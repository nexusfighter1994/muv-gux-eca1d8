'use strict';
// ONE routing point for every Frameshift render of a running process: wraps the
// @vidforge/frameshift package `render` binding. Alpha MOV overlays and opaque MP4
// motion go to the Home GPU through the current hooks; everything else, and every
// Home failure, runs the original renderer with its FULL deadline. Validity equals
// binding.render/renderOverlay: licensed job, native scope and live frameshift lease.
// Server fallbacks run inside `bypass` so a fallback is never offered to Home twice.
const { AsyncLocalStorage } = require('node:async_hooks');

const bypass = new AsyncLocalStorage();
const MAIN = /<[a-zA-Z][^>]*\bdata-composition-id\s*=\s*(["'])main\1[^>]*>/g;
const ALPHA_HEADER = /^<!doctype html>\s*<html>\s*<head>\s*<meta charset="utf-8">\s*<style>[^<]*<\/style>\s*<\/head>\s*<body>\s*<div id="root" data-composition-id="main" data-start="0" data-duration="([0-9]+(?:\.[0-9]+)?)" data-width="1920" data-height="1080">/;

function opaqueDuration(html) {
  if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) return null;
  const tags = html.match(MAIN);
  if (!tags || tags.length !== 1) return null;
  const m = /\bdata-duration\s*=\s*(["'])([^"']*)\1/.exec(tags[0]);
  const value = m ? Number(m[2]) : NaN;
  return Number.isFinite(value) && value > 0 && value <= 15 ? value : null;
}
// Same recognizer as binding.mjs overlayDuration (original Za overlay header only).
function alphaDuration(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024) return null;
  const root = ALPHA_HEADER.exec(html);
  if (!root || (html.match(/\bdata-composition-id\s*=/gi) || []).length !== 1) return null;
  const d = Number(root[1]);
  return Number.isFinite(d) && d > 0 && d <= 15 ? d : null;
}

// Mirrors alpha-hook.mjs eligible() so a refusal is visible with its reason.
const ALPHA_KEYS = new Set(['compositionHtml', 'renderOnlyHtml', 'assets', 'fps', 'resolution', 'workers',
  'quality', 'format', 'timeoutMs', 'targetPath', 'workDir', 'signal', 'onProgress', 'onStatus']);
function alphaShape(o) {
  if (o.fps !== 24) return 'alpha_fps_' + o.fps;
  if (o.resolution !== '1920x1080') return 'alpha_resolution';
  if (!['draft', 'standard', 'high'].includes(o.quality ?? 'standard')) return 'alpha_quality_' + o.quality;
  if (typeof o.targetPath !== 'string' || typeof o.workDir !== 'string') return 'alpha_paths';
  const extra = Object.keys(o).filter(k => !ALPHA_KEYS.has(k));
  if (extra.length) return 'alpha_option_' + extra.sort().join('+');
  if (!Array.isArray(o.assets ?? [])) return 'alpha_assets';
  const bad = (o.assets ?? []).find(a => !a || typeof a.localPath !== 'string' || Object.keys(a).some(k => !['filename', 'localPath'].includes(k)));
  if (bad) return 'alpha_asset_keys_' + Object.keys(bad || {}).sort().join('+');
  return null;
}

// Native leases often carry no AbortSignal (Me.run without signal). Then a watchdog
// polls the SAME validity check and aborts the Home render as soon as the lease,
// license or job is gone; native cancellation semantics stay authoritative.
function leaseSignal(signals, valid, pollMs = 2000) {
  const list = signals.filter(Boolean);
  const controller = new AbortController();
  const timer = setInterval(() => {
    let ok = false;
    try { ok = valid(); } catch { ok = false; }
    if (!ok) controller.abort(Object.assign(Error('native render scope ended'), { noFallback: true }));
  }, pollMs);
  timer.unref?.();
  return { signal: AbortSignal.any([...list, controller.signal]), stop: () => clearInterval(timer), watchdog: list.length === 0 };
}

function createFrameshiftRoute({ RU, getStore, mF, jp, getJobs, Xl, isJobAborted, getConfig, loadOpaque, loadAlpha,
  opaqueUrl, alphaUrl, reserveRatio = 0.3, healthTimeoutMs = 5000, maxSamples = 12, maxRemote = 2 }) {
  // Persisted install runs before the native scheduler initialises: accept a getter.
  if (!jp && typeof getJobs === 'function') jp = { get: id => getJobs()?.get?.(id) };
  // Home has ONE graphics slot: extra concurrent offers would upload, get "busy" and
  // briefly inflate the +1 capacity. They go straight to the server instead.
  // Last Home exchanges (path, status, Home error text, duration) for diagnosis.
  const homeLog = [];
  const logHome = entry => { homeLog.push({ at: new Date().toISOString(), ...entry }); if (homeLog.length > 30) homeLog.shift(); };
  const tracedFetch = async (url, init = {}) => {
    const started = Date.now(), path = new URL(url).pathname.replace(/[a-f0-9]{32}/, ':id');
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        let text = '';
        try { text = (await response.clone().text()).slice(0, 300); } catch { /* body unavailable */ }
        logHome({ path, method: init.method || 'GET', status: response.status, ms: Date.now() - started, error: text });
      } else if (path !== '/motion/health' && path !== '/map/health') {
        logHome({ path, method: init.method || 'GET', status: response.status, ms: Date.now() - started });
      }
      return response;
    } catch (error) {
      logHome({ path, method: init.method || 'GET', status: null, ms: Date.now() - started, error: String(error?.message || error).slice(0, 200) });
      throw error;
    }
  };
  let inflight = 0;
  const takeSlot = () => (inflight < maxRemote ? (inflight++, true) : false);
  const giveSlot = () => { inflight = Math.max(0, inflight - 1); };
  if (!loadOpaque && typeof opaqueUrl === 'string') loadOpaque = () => import(opaqueUrl);
  if (!loadAlpha && typeof alphaUrl === 'string') loadAlpha = () => import(alphaUrl);
  for (const [name, fn] of Object.entries({ RU, getStore, mF, Xl, isJobAborted, getConfig, loadOpaque, loadAlpha })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a function');
  }
  if (!jp || typeof jp.get !== 'function') throw new TypeError('jp must be a Map');
  const stats = { calls: 0, bypassed: 0, alpha: { tried: 0, home: 0, native: 0 }, opaque: { tried: 0, home: 0, native: 0 },
    errors: 0, active: 0, reasons: {}, samples: [], last: null };
  const reject = (reason, options) => {
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    if (stats.samples.length < maxSamples) {
      stats.samples.push({ reason, at: new Date().toISOString(), format: options?.format ?? null, workers: options?.workers ?? null,
        keys: options ? Object.keys(options).sort() : null, assetKeys: [...new Set((options?.assets || []).flatMap(a => Object.keys(a || {})))] });
    }
    return null;
  };

  function context() {
    const scope = getStore(), jobId = scope?.jobId, lane = mF('frameshift');
    return { jobId, scope, lane, lease: scope?.leases?.get(lane), licensed: RU(),
      outerSignal: Xl(), checkAbort: () => jp.get(jobId)?.checkAbort?.(), isAborted: () => isJobAborted(jobId) };
  }
  function validFor(ctx) {
    return () => {
      ctx.checkAbort();
      const scope = getStore();
      return typeof ctx.jobId === 'string' && !!ctx.jobId && ctx.licensed === ctx.jobId && RU() === ctx.jobId
        && scope === ctx.scope && scope?.jobId === ctx.jobId && scope?.lanes?.has(ctx.lane)
        && scope?.leases?.get(ctx.lane) === ctx.lease && ctx.lease?.resourceKey === 'frameshift'
        && ctx.lease.released === false && ctx.lease.parked === false && !ctx.isAborted();
    };
  }
  function whyInvalid(ctx) {
    const scope = getStore();
    if (RU() !== ctx.jobId) return 'license_changed';
    if (scope !== ctx.scope) return 'scope_changed';
    if (!scope?.lanes?.has(ctx.lane)) return 'lane_missing';
    if (scope?.leases?.get(ctx.lane) !== ctx.lease) return 'lease_changed';
    if (ctx.lease?.released !== false) return 'lease_released_' + ctx.lease?.released;
    if (ctx.lease?.parked !== false) return 'lease_parked_' + ctx.lease?.parked;
    if (ctx.isAborted()) return 'job_aborted';
    return 'unknown';
  }
  function precheck(ctx, options) {
    const c = getConfig();
    if (!c || c.getSettings?.()?.homeMotion !== true) return reject('home_disabled', options);
    if (!ctx.jobId) return reject('no_scope', options);
    if (ctx.licensed !== ctx.jobId) return reject('license_mismatch', options);
    if (ctx.lease?.resourceKey !== 'frameshift') return reject('no_frameshift_lease', options);
    if (ctx.lease.released || ctx.lease.parked) return reject('lease_inactive', options);
    return c;
  }

  function wrap(original) {
    if (typeof original !== 'function') throw new TypeError('original must be a function');
    if (original.__vfFrameshiftRoute) return original;
    const routed = async function render(options) {
      stats.calls++;
      const self = this, native = o => bypass.run(true, () => Reflect.apply(original, self, [o]));
      if (bypass.getStore()) { stats.bypassed++; return Reflect.apply(original, this, [options]); }
      const format = options?.format;
      const kind = format === 'mov' ? 'alpha' : (format === undefined || format === 'mp4') ? 'opaque' : null;
      if (!kind) { reject('format_' + format, options); return native(options); }
      const workers = options?.workers ?? 1;
      if (!Number.isInteger(workers) || workers < 1 || workers > 3) { reject('workers_' + workers, options); return native(options); }
      const ctx = context(), c = precheck(ctx, options);
      if (!c) return native(options);
      const duration = kind === 'alpha' ? alphaDuration(options.compositionHtml) : opaqueDuration(options.compositionHtml);
      if (duration === null) { reject(kind + '_composition', options); return native(options); }
      const shape = kind === 'alpha' ? alphaShape(options) : null;
      if (shape) { reject(shape, options); return native(options); }
      const valid = validFor(ctx);
      let validNow = false;
      try { validNow = valid(); } catch { validNow = false; }
      if (!validNow) { reject('invalid_' + whyInvalid(ctx), options); return native(options); }
      if (!takeSlot()) { reject('home_busy', null); return native(options); }
      const watch = leaseSignal([ctx.lease?.signal, ctx.outerSignal, options?.signal], valid), signal = watch.signal;
      if (watch.watchdog) stats.watchdog = (stats.watchdog || 0) + 1;
      const bucket = stats[kind];
      bucket.tried++; stats.active++;
      let usedNative = false;
      const fallback = o => { usedNative = true; giveSlot(); return native(o); };
      const shared = { ...c, fetchImpl: c.fetchImpl ?? tracedFetch, token: c.getToken(), permitted: valid, nativeReserveRatio: reserveRatio, healthTimeoutMs, freshNativeBudget: true };
      try {
        let result;
        if (kind === 'alpha') {
          const { createAlphaHook } = await loadAlpha();
          result = await createAlphaHook(fallback, shared)(options, { kind: 'frameshift-alpha-v1', duration, signal });
        } else {
          const { createMotionHook } = await loadOpaque();
          result = await createMotionHook(fallback, shared)(options, { signal, duration });
        }
        if (usedNative) bucket.native++;
        else { bucket.home++; stats.last = { kind, jobId: ctx.jobId, at: new Date().toISOString(), path: options.targetPath }; }
        return result;
      } catch (error) { stats.errors++; throw error; }
      finally { watch.stop(); if (!usedNative) giveSlot(); stats.active--; }
    };
    routed.__vfFrameshiftRoute = true;
    routed.original = original;
    return routed;
  }
  // ---- Low level: renders whose callers captured the ORIGINAL package render ----
  // The original render materializes + validates on the server, then calls the live
  // `runRender` binding. That call is offered to Home with the exact composition,
  // render-only markup and media the server would have rendered.
  const compositions = new Map();
  stats.low = { calls: 0, tried: 0, home: 0, native: 0 };
  function wrapMaterialize(original) {
    if (typeof original !== 'function') throw new TypeError('original must be a function');
    if (original.__vfFrameshiftRoute) return original;
    const wrapped = async function materializeProject(workDir, compositionHtml, ...rest) {
      const paths = await Reflect.apply(original, this, [workDir, compositionHtml, ...rest]);
      try {
        if (paths?.projectDir && typeof compositionHtml === 'string') {
          compositions.set(paths.projectDir, { html: compositionHtml, mediaDir: paths.mediaDir, artifactsDir: paths.artifactsDir });
          while (compositions.size > 800) compositions.delete(compositions.keys().next().value);
        }
      } catch { /* Recording never affects the native render. */ }
      return paths;
    };
    wrapped.__vfFrameshiftRoute = true;
    wrapped.original = original;
    return wrapped;
  }
  async function lowOptions(args, rec) {
    const fsp = require('node:fs/promises'), path = require('node:path');
    const index = await fsp.readFile(path.join(args.projectDir, 'index.html'), 'utf8');
    let renderOnlyHtml = '';
    if (index !== rec.html) {
      // Inverse of withRenderOnlyHtml(): markup + "\n" inserted before the last </body>.
      const at = rec.html.search(/<\/body>(?![\s\S]*<\/body>)/i);
      if (at < 0) return 'low_render_only_shape';
      const head = rec.html.slice(0, at), tail = rec.html.slice(at);
      if (!index.startsWith(head) || !index.endsWith('\n' + tail) || index.length < rec.html.length + 1) return 'low_render_only_shape';
      renderOnlyHtml = index.slice(at, index.length - tail.length - 1);
    }
    const entries = await fsp.readdir(rec.mediaDir, { withFileTypes: true }).catch(() => []);
    if (entries.some(e => !e.isFile())) return 'low_media_layout';
    const tag = (rec.html.match(MAIN) || [])[0] || '';
    const width = /\bdata-width\s*=\s*(["'])(\d+)\1/.exec(tag)?.[2], height = /\bdata-height\s*=\s*(["'])(\d+)\1/.exec(tag)?.[2];
    if (width !== '1920' || height !== '1080') return 'low_resolution';
    return { compositionHtml: rec.html, renderOnlyHtml, fps: args.fps, resolution: '1920x1080',
      assets: entries.map(e => ({ filename: e.name, localPath: path.join(rec.mediaDir, e.name) })),
      ...(args.workers ? { workers: args.workers } : {}), ...(args.quality ? { quality: args.quality } : {}),
      targetPath: args.outputPath, workDir: path.dirname(rec.artifactsDir || args.projectDir), timeoutMs: args.timeoutMs ?? 600000,
      ...(args.format === 'mov' ? { format: 'mov' } : {}) };
  }
  function wrapRunRender(original) {
    if (typeof original !== 'function') throw new TypeError('original must be a function');
    if (original.__vfFrameshiftRoute) return original;
    const wrapped = async function runRender(args) {
      const self = this, passthrough = () => bypass.run(true, () => Reflect.apply(original, self, [args]));
      if (bypass.getStore()) return Reflect.apply(original, this, [args]);
      stats.low.calls++;
      const rec = compositions.get(args?.projectDir);
      if (args?.projectDir) compositions.delete(args.projectDir);
      if (!rec) { reject('low_no_composition', null); return passthrough(); }
      const kind = args.format === 'mov' ? 'alpha' : args.format === 'mp4' ? 'opaque' : null;
      if (!kind) { reject('low_format_' + args.format, null); return passthrough(); }
      const workers = args.workers ?? 1;
      if (!Number.isInteger(workers) || workers < 1 || workers > 3) { reject('low_workers_' + workers, null); return passthrough(); }
      const ctx = context(), c = precheck(ctx, null);
      if (!c) return passthrough();
      const duration = kind === 'alpha' ? alphaDuration(rec.html) : opaqueDuration(rec.html);
      if (duration === null) { reject('low_' + kind + '_composition', null); return passthrough(); }
      let options;
      try { options = await lowOptions(args, rec); } catch { options = 'low_read_failed'; }
      if (typeof options === 'string') { reject(options, null); return passthrough(); }
      const shape = kind === 'alpha' ? alphaShape(options) : null;
      if (shape) { reject('low_' + shape, options); return passthrough(); }
      const valid = validFor(ctx);
      let validNow = false, why = null;
      try { validNow = valid(); } catch { why = 'low_scope_aborted'; }
      if (!validNow) { reject(why || 'low_invalid_' + whyInvalid(ctx), null); return passthrough(); }
      if (!takeSlot()) { reject('low_home_busy', null); return passthrough(); }
      const watch = leaseSignal([ctx.lease?.signal, ctx.outerSignal, args.signal], valid), signal = watch.signal;
      if (watch.watchdog) stats.watchdog = (stats.watchdog || 0) + 1;
      stats.low.tried++; stats.active++;
      let usedNative = false, nativeResult;
      // Release the Home slot before the (long) server render so the next offer can use Home.
      const fallback = async () => { usedNative = true; giveSlot(); nativeResult = await passthrough(); return nativeResult; };
      const shared = { ...c, fetchImpl: c.fetchImpl ?? tracedFetch, token: c.getToken(), permitted: valid, nativeReserveRatio: reserveRatio, healthTimeoutMs, freshNativeBudget: true };
      try {
        if (kind === 'alpha') {
          const { createAlphaHook } = await loadAlpha();
          await createAlphaHook(fallback, shared)(options, { kind: 'frameshift-alpha-v1', duration, signal });
        } else {
          const { createMotionHook } = await loadOpaque();
          await createMotionHook(fallback, shared)(options, { signal, duration });
        }
        if (usedNative) { stats.low.native++; return nativeResult; }
        stats.low.home++;
        stats.last = { kind: 'low-' + kind, jobId: ctx.jobId, at: new Date().toISOString(), path: args.outputPath };
        return { code: 0, timedOut: false, stdout: '', stderr: '' };
      } catch (error) { stats.errors++; throw error; }
      finally { watch.stop(); if (!usedNative) giveSlot(); stats.active--; }
    };
    wrapped.__vfFrameshiftRoute = true;
    wrapped.original = original;
    return wrapped;
  }
  // Persisted entry: build-time trampolines in @vidforge/frameshift call route.call().
  const wrappers = { render: wrap, runRender: wrapRunRender, materializeProject: wrapMaterialize };
  const memo = new Map();
  function call(name, original, self, args) {
    let entry = memo.get(name);
    if (!entry || entry.original !== original) memo.set(name, entry = { original, wrapped: wrappers[name](original) });
    return Reflect.apply(entry.wrapped, self, args);
  }
  return { wrap, wrapMaterialize, wrapRunRender, call, stats, bypass, compositions, homeLog };
}

module.exports = { createFrameshiftRoute, opaqueDuration, alphaDuration, bypass };
