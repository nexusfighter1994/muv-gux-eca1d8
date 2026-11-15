'use strict';
// Home queue admission for FFlow-routed Home work (compositions, video trims). Claims may run
// ahead of the pool's ready workers: a claimed job is still prepared on the server before FFlow
// queues it, and the pool only grows from busy workers (pc_home_pool.py), so admitting exactly
// readyWorkers kept ready workers idle and the pool small while hundreds of jobs waited.
// Limit = min(Home capacity, max(2 x ready, ready + 4)); 0 while the pool is not ready.
const fs = require('node:fs');
const POOL_PATH = '/data/runtime/pc-home-pool.json';

function claimLimit(requested, ready) {
  if (!(Number(ready) > 0) || !(Number(requested) > 0)) return 0;
  return Math.min(requested, Math.max(ready * 2, ready + 4));
}

// The pool file as the pool manager writes it every second; read at most once per second.
function createPoolReader({ path = POOL_PATH, now = Date.now, read = p => JSON.parse(fs.readFileSync(p, 'utf8')) } = {}) {
  let cached = { at: -Infinity, value: null };
  return () => {
    const t = now();
    if (t - cached.at >= 1000) {
      let value = null;
      try { value = read(path); } catch { value = null; }
      cached = { at: t, value };
    }
    return cached.value;
  };
}

function readyWorkers(pool, now = Date.now()) {
  return pool?.mode === 'home-only' && pool.ready && now - pool.checkedAt < 45000 ? Math.max(0, Number(pool.readyWorkers) || 0) : 0;
}

function makeCanClaim({ getCapacity, readPool = createPoolReader(), now = Date.now }) {
  return (w, scopes) => {
    if (w.homeKind === 'video-normalize') return true;
    const limit = claimLimit(Number(getCapacity()) || 0, readyWorkers(readPool(), now()));
    let flow = 0;
    for (const s of scopes) if (s.kind !== 'video-normalize') flow++;
    return flow < limit;
  };
}

// Scopes parked in a server recovery permit run on the server, not in a Home pool worker. Counting
// them against the claim limit froze admission after the Home worker restart (2026-11-05 08:17:
// 7/40 scopes, pool stuck at 2-4 workers, 1,018 waiting), because the pool only grows from claims.
function excludeRecovering(canClaim, { getItems = () => globalThis.__vfHomeRecoveryItems, now = Date.now } = {}) {
  if (canClaim?.__vfExcludesRecovering) return canClaim;
  let cached = { at: -Infinity, nonces: new Set() };
  const parked = () => {
    const t = now();
    if (t - cached.at >= 250 || t < cached.at) {
      const nonces = new Set(), items = getItems();
      if (items instanceof Map) for (const item of items.values()) {
        if (item?.scope?.nonce && !item.controller?.signal?.aborted) nonces.add(item.scope.nonce);
      }
      cached = { at: t, nonces };
    }
    return cached.nonces;
  };
  const wrapped = (w, scopes) => {
    const nonces = parked();
    return canClaim(w, scopes.filter(s => !nonces.has(s?.nonce) && !Object.hasOwn(s ?? {}, 'candidate')));
  };
  wrapped.__vfExcludesRecovering = true;
  wrapped.__vfPoolScopesOnly = true;
  return wrapped;
}

// Scene detections (scopes born as candidates, home-scenes.mjs) run in the Node scene CLI, not in a
// pool worker. After the restart drain shrank the pool to 2-4 workers, 10 scene scopes filled the
// claim limit (7) and 1,104 waiters stayed unclaimable, so the pool never grew back.
function poolScopesOnly(canClaim, options) {
  if (canClaim?.__vfPoolScopesOnly) return canClaim;
  return excludeRecovering(Object.assign((w, scopes) => canClaim(w, scopes), {}), options);
}

// Compositions move big inputs to Home and big results back over the throttled home line. 30 at once
// (2026-11-05 22:05) cut transfers: 154 failed result downloads, 86 timeouts, 53 dropped connections
// in 25 min, each a fallback, and segments fell from 221 to ~55/10 min. Trims and normalizes are small.
const COMPOSITION_CAP = 10;
// vf-custom:composition-cap-runtime-v1 (2026-11-13): the cap can be changed without a restart, so Home's CPU
// slots can be shifted between long compositions and small work while measuring:
// /data/runtime/vf-home-claim.json {"compositionCap": 1-20}. Missing or invalid = COMPOSITION_CAP.
const CLAIM_PATH = '/data/runtime/vf-home-claim.json';
const validCap = value => Number.isInteger(value) && value >= 1 && value <= 20;
function createCapReader({ path = CLAIM_PATH, now = Date.now, read = p => fs.readFileSync(p, 'utf8') } = {}) {
  let cached = { at: -Infinity, value: null };
  return () => {
    const t = now();
    if (t - cached.at >= 1000 || t < cached.at) {
      let value = null;
      try { value = JSON.parse(read(path))?.compositionCap; } catch { value = null; }
      cached = { at: t, value: validCap(value) ? value : null };
    }
    return cached.value;
  };
}
function limitCompositions(canClaim, { cap = COMPOSITION_CAP, readCap = createCapReader() } = {}) {
  if (canClaim?.__vfCompositionCap) return canClaim;
  const isComposition = item => (item?.kind || item?.homeKind || '') === 'composition' || item?.resourceKey === 'fflowComposition';
  const wrapped = (w, scopes) => {
    if (isComposition(w)) {
      const runtime = readCap();
      if (scopes.filter(isComposition).length >= (validCap(runtime) ? runtime : cap)) return false;
    }
    return canClaim(w, scopes);
  };
  wrapped.__vfCompositionCap = cap;
  wrapped.__vfExcludesRecovering = canClaim?.__vfExcludesRecovering;
  wrapped.__vfPoolScopesOnly = canClaim?.__vfPoolScopesOnly;
  return wrapped;
}

module.exports = { claimLimit, createPoolReader, readyWorkers, makeCanClaim, excludeRecovering, poolScopesOnly,
  limitCompositions, createCapReader, COMPOSITION_CAP, CLAIM_PATH };
