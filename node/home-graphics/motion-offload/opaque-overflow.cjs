'use strict';
// HOT bridge for an already-running process whose cached binding/hook only offload
// workers===1. The shared native Frameshift provider's render method is wrapped in
// place, so renders that are ALREADY waiting for a slot use Home once admitted.
// Only opaque MP4 renders with source workers 2..3 (the ones the old route declines)
// are bridged; lease validation equals binding.render, context comes from the
// native AsyncLocalStorage at call time. A restarted process loads hook.mjs
// directly (workers 1..3) and never needs this bridge.
const remote = require('../remote-active.cjs');

const MAIN = /<[a-zA-Z][^>]*\bdata-composition-id\s*=\s*(["'])main\1[^>]*>/g;
// Duration the native renderer will actually render (Pxe conforms it in the HTML).
function compositionDuration(html) {
  if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) return null;
  const tags = html.match(MAIN);
  if (!tags || tags.length !== 1) return null;
  const m = /\bdata-duration\s*=\s*(["'])([^"']*)\1/.exec(tags[0]);
  const value = m ? Number(m[2]) : NaN;
  return Number.isFinite(value) && value > 0 && value <= 15 ? value : null;
}

function createOpaqueBridge({ RU, getStore, mF, jp, Xl, isJobAborted, getConfig, loadHook, hookUrl,
  reserveRatio = 0.3, healthTimeoutMs = 5000 }) {
  if (!loadHook && typeof hookUrl === 'string') loadHook = () => import(hookUrl);
  for (const [name, fn] of Object.entries({ RU, getStore, mF, Xl, isJobAborted, getConfig, loadHook })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a function');
  }
  if (!(jp instanceof Map)) throw new TypeError('jp must be a Map');
  const stats = { calls: 0, adopted: 0, providers: 0, bridged: 0, home: 0, native: 0, errors: 0, active: 0, last: null };
  const adopted = new WeakSet();

  async function renderHome(native, context, options) {
    const c = getConfig();
    if (!c || c.getSettings()?.homeMotion !== true) return native(options);
    const scope = context.getScope(), lease = scope?.leases?.get(context.lane);
    const signal = lease?.signal ?? context.outerSignal;
    const valid = () => {
      context.checkAbort();
      return typeof context.jobId === 'string' && context.licensedJobId === context.jobId && scope?.jobId === context.jobId
        && scope?.lanes?.has(context.lane) && context.getScope()?.leases?.get(context.lane) === lease
        && lease?.resourceKey === 'frameshift' && !lease.released && !lease.parked && !context.isAborted();
    };
    if (!signal || !valid()) return native(options);
    const { createMotionHook } = await loadHook();
    let usedNative = false;
    const result = await createMotionHook(o => { usedNative = true; return native(o); },
      { ...c, token: c.getToken(), permitted: valid, nativeReserveRatio: reserveRatio, healthTimeoutMs, freshNativeBudget: true })(options,
      { signal, duration: context.duration });
    if (usedNative) stats.native++; else { stats.home++; stats.last = { jobId: context.jobId, at: new Date().toISOString(), path: options.targetPath }; }
    return result;
  }

  function wrapRender(original) {
    return async function render(options) {
      const native = o => Reflect.apply(original, this, [o]);
      const w = options?.workers;
      const opaque = options && (options.format === undefined || options.format === 'mp4');
      // workers===1 was already offered to Home by the original route; alpha MOV has its own route.
      if (!opaque || !(Number.isInteger(w) && w >= 2 && w <= 3)) return native(options);
      const duration = compositionDuration(options.compositionHtml);
      if (duration === null) return native(options);
      const scope = getStore(), jobId = scope?.jobId;
      stats.bridged++; stats.active++;
      const context = { jobId, licensedJobId: RU(), getScope: () => getStore(), lane: mF('frameshift'),
        checkAbort: () => jp.get(jobId)?.checkAbort?.(), isAborted: () => isJobAborted(jobId), outerSignal: Xl(), duration };
      try { return await renderHome(native, context, options); }
      catch (error) { stats.errors++; throw error; }
      finally { stats.active--; }
    };
  }

  // Wrap the provider's render in place (own property); idempotent per provider.
  function adopt(provider) {
    if (!provider || typeof provider.render !== 'function' || adopted.has(provider)) return false;
    const original = provider.render;
    provider.render = wrapRender(original);
    if (provider.render === original) return false;
    adopted.add(provider);
    stats.providers++;
    return true;
  }

  function wrapRenderer(originalRenderer) {
    if (typeof originalRenderer !== 'function') throw new TypeError('original must be a function');
    return async function opaqueHome(args) {
      stats.calls++;
      try { if (adopt(args?.frameshiftImpl)) stats.adopted++; } catch { /* Never block the native renderer. */ }
      return Reflect.apply(originalRenderer, this, arguments);
    };
  }
  return { wrapRenderer, adopt, stats };
}

// Hot equivalents of the persisted home-graphics-capacity hook and laneSize rule.
function wrapRenderLane(original) {
  return function renderLane(lane) {
    const size = Reflect.apply(original, this, arguments);
    return lane === 'render' && Number.isFinite(size) ? size + remote.total() : size;
  };
}
function wrapFrameshiftCap(original, limit) {
  if (typeof limit !== 'function') throw new TypeError('limit must be a function');
  return function frameshiftCap(lane, size, resource) {
    return lane === 'render' && resource === 'frameshift'
      ? Math.min(size, limit() + remote.active('frameshift')) : Reflect.apply(original, this, arguments);
  };
}

module.exports = { createOpaqueBridge, wrapRenderLane, wrapFrameshiftCap, compositionDuration, remote };
