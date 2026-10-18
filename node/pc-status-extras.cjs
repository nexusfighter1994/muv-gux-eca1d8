'use strict';
// Extra live fields for GET /api/pc-boost (Concurrency panel rows "Home PC Motion" and "Home PC
// SigLIP"): what the frameshift route sent to the PC vs the server since it started, and how many
// SigLIP embeddings the server itself runs while the PC is ready (siglip-native-cap.cjs).
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function statusExtras() {
  const route = globalThis.__vfFrameshiftRoute?.stats, cap = globalThis.__vfSiglipNativeCap;
  const sum = key => (route ? (count(route.opaque?.[key]) ?? 0) + (count(route.alpha?.[key]) ?? 0) : null);
  return {
    homeMotion: route ? {
      slots: count(route.limits?.slots), inFlight: count(route.active),
      opaqueHome: count(route.opaque?.home), alphaHome: count(route.alpha?.home), pod: count(route.pod?.home),
      native: sum('native'), tried: sum('tried'),
    } : null,
    siglipServer: cap ? { embeds: count(cap.active), max: count(cap.limit) ?? 1, waitingForPc: count(cap.held) } : null,
  };
}

// Adds statusExtras() to the GET /api/pc-boost reply (once per handler).
function wrapStatusRoute(app) {
  const stack = app?._router?.stack || app?.router?.stack;
  let wrapped = 0;
  for (const layer of stack || []) {
    if (layer.route?.path !== '/api/pc-boost' || !layer.route.methods.get) continue;
    const entry = layer.route.stack.at(-1), original = entry.handle;
    if (original.__vfStatusExtras) continue;
    const handle = function (req, res, next) {
      const send = res.json;
      res.json = function (body) {
        res.json = send;
        let extras = {};
        try { extras = statusExtras(); } catch { /* status stays as before */ }
        return send.call(this, body && typeof body === 'object' ? { ...body, ...extras } : body);
      };
      return original.call(this, req, res, next);
    };
    handle.__vfStatusExtras = true;
    entry.handle = handle;
    wrapped++;
  }
  return wrapped;
}

module.exports = { statusExtras, wrapStatusRoute };
