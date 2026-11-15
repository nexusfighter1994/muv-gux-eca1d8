'use strict';
// vf-custom:siglip-candidate-cap-v1 (2026-11-13)
// siglip-recovery-headroom.cjs admits at most 2 SigLIP waiters of kind "siglip-home-candidate" at a time
// (a candidate is a waiter whose callback is not yet known to be a Home embed). On 2026-11-13 every
// waiter was such a candidate, so the Home GPU got 2 requests in preparation plus 0-2 submitted out of
// 8 slots while 450 waited (GPU 0-4 % between bursts, ~20 ranks/min) and the server ranked the rest on
// its CPU. Candidates turned out to be Home embeds practically always (recovering 0, 1 native recovery
// in 30 min). This module makes the limit a runtime value:
//   /data/runtime/vf-siglip-candidate-cap.json  {"cap": 4}     (1-12; missing or invalid = 2, as before)
// The drain below is the headroom drain verbatim, only the literal 2 is read from that file.
const fs = require('node:fs');
const VERSION = 'siglip-candidate-cap-v1';
const FILE = process.env.VF_SIGLIP_CANDIDATE_CAP_FILE || '/data/runtime/vf-siglip-candidate-cap.json';
const DEFAULT_CAP = 2, MAX_CAP = 12, RECOVERY_HEADROOM = 50;
const valid = value => Number.isInteger(value) && value >= 1 && value <= MAX_CAP;

function createCapReader({ file = FILE, now = Date.now, read = path => fs.readFileSync(path, 'utf8') } = {}) {
  let checked = -Infinity, cap = DEFAULT_CAP;
  return () => {
    const time = now();
    if (time - checked >= 1000) {
      checked = time;
      try { const value = JSON.parse(read(file)).cap; cap = valid(value) ? value : DEFAULT_CAP; }
      catch { cap = DEFAULT_CAP; }
    }
    return cap;
  };
}

function createDrain({ getState, getCapacity, claim, scopes, isAborted = () => false, newNonce, readCap }) {
  if (![getState, getCapacity, claim, isAborted, newNonce, readCap].every(fn => typeof fn === 'function'))
    throw new TypeError('SigLIP drain dependencies required');
  if (!(scopes instanceof Map)) throw new TypeError('SigLIP scope registry required');
  let draining = false, admitted = 0;
  const capacity = () => Math.max(0, Math.min(25, Number(getCapacity()) || 0));
  const homeScopes = () => [...scopes.values()].filter(s => !s.recovering);
  const candidates = () => homeScopes().filter(s => s.candidate).length;
  const eligible = w => w.resourceKey === 'siglip' && ['siglip-home', 'siglip-home-candidate'].includes(w.homeKind)
    && !isAborted(w.jobId) && !w.signal?.aborted;
  const drain = function () {
    if (draining) return;
    draining = true;
    try {
      while (homeScopes().length < capacity() && scopes.size < capacity() + RECOVERY_HEADROOM) {
        const cap = readCap();
        const w = getState().waiters.filter(eligible)
          .filter(w => w.homeKind !== 'siglip-home-candidate' || candidates() < cap)
          .sort((a, b) => a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : a.seq - b.seq)[0];
        if (!w) break;
        const scope = { jobId: w.jobId, nonce: newNonce(), kind: 'siglip-embed', resourceKey: 'siglip',
          candidate: w.homeKind === 'siglip-home-candidate', signal: w.signal, opKey: w.opKey, quality: w.quality };
        scopes.set(scope.nonce, scope);
        try { claim(w, scope); admitted++; } catch (error) { scopes.delete(scope.nonce); throw error; }
      }
    } finally { draining = false; }
  };
  drain.__vfCandidateCap = VERSION;
  drain.admitted = () => admitted;
  return drain;
}

// Hot install on the running queue (the closure values come from a breakpoint inside the old drain).
function installOn(queue, deps, { readCap = createCapReader() } = {}) {
  if (!queue || typeof queue.drain !== 'function' || typeof queue.stats !== 'function') throw new TypeError('SigLIP queue required');
  if (queue.__vfCandidateCap) return queue.__vfCandidateCap;
  const previousDrain = queue.drain, previousStats = queue.stats;
  const drain = createDrain({ ...deps, readCap });
  const stats = function () {
    const value = previousStats.call(this);
    return { ...value, admitted: (Number(value.admitted) || 0) + drain.admitted(), candidateCap: readCap() };
  };
  const handle = { version: VERSION, cap: readCap, previousDrain, previousStats,
    restore() {
      if (queue.drain !== drain || queue.stats !== stats) throw Error('SigLIP queue ownership changed');
      queue.drain = previousDrain; queue.stats = previousStats; delete queue.__vfCandidateCap;
    } };
  queue.drain = drain; queue.stats = stats; queue.__vfCandidateCap = handle;
  return handle;
}

module.exports = { VERSION, FILE, DEFAULT_CAP, MAX_CAP, createCapReader, createDrain, installOn };
