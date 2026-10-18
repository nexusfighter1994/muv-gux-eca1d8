'use strict';
// While the Home PC SigLIP is healthy, embedding waiters (homeKind "siglip-home") are left to the
// PC: the server's native SigLIP lane admits at most siglipServerEmbeds (PC Boost setting, 0..25,
// default NATIVE_EMBEDS) of them at a time. OCR
// ("siglip-server"), native recoveries and legacy candidates are untouched; when the PC is not
// healthy the native lane behaves as before.
// A native admission of an embedding waiter is marked in its lease (homeScope = TOKEN, a string so
// the lease is never mistaken for a Home scope) and counted until its release.
const NATIVE_EMBEDS = 1;
const TOKEN = 'vf-native-embed';
const RUNTIME_PATH = '/data/runtime/pc-boost.json';
const state = globalThis.__vfSiglipNativeCap ||= { active: 0, admitted: 0, released: 0, held: 0 };

// The setting as published in the PC Boost runtime file, re-read at most every 2 s.
let cached = { at: 0, value: NATIVE_EMBEDS };
function configuredLimit(now = Date.now(), read = () => JSON.parse(require('node:fs').readFileSync(process.env.VF_PC_BOOST_CONFIG || RUNTIME_PATH, 'utf8'))) {
  if (now - cached.at > 2000) {
    let value = NATIVE_EMBEDS;
    try { const v = read()?.siglipServerEmbeds; if (Number.isSafeInteger(v) && v >= 0 && v <= 25) value = v; } catch { /* default */ }
    cached = { at: now, value };
  }
  return cached.value;
}

const isEmbed = w => w?.homeKind === 'siglip-home';

// Ready = a successful Home health probe within READY_MS. One failed probe on a loaded server
// (event-loop lag past the probe timeout) must not hand the embeddings back to the server.
const READY_MS = 30000;
function homeReady(now = Date.now()) {
  try {
    const s = globalThis.__vfHomeSiglipHealth?.snapshot?.();
    return Number.isFinite(s?.checkedAt) && s.checkedAt > 0 && now - s.checkedAt < READY_MS;
  } catch { return false; }
}

// Mark embedding waiters so a native admission (lease without a Home scope) is counted.
function tag(waiters) {
  for (const w of waiters) {
    if (!isEmbed(w) || w.__vfNativeCapTagged || typeof w.resolve !== 'function') continue;
    w.__vfNativeCapTagged = true;
    const resolve = w.resolve;
    w.resolve = lease => {
      if (lease?.homeScope) return resolve(lease);
      state.active += 1;
      state.admitted += 1;
      return resolve({ ...lease, homeScope: TOKEN });
    };
  }
}

// Wraps the native dispatcher (first admissible waiter of a lane). For the SigLIP lane at the
// cap, embedding waiters move behind the others (stable; the memory branch then picks a job's OCR
// before its embeddings) and are skipped; the rest is admitted exactly like the native scan.
function wrapDispatch(original, getAdmission, ready = homeReady, cap = configuredLimit) {
  if (original?.__vfNativeCap) return original;
  // Below the cap the scan is the plain native one. A cap wrapper from an earlier hot install
  // inside (fixed at 1) must not apply its own limit: it sees no active native embeddings.
  const plain = (self, args) => {
    const { active, limit } = state;
    state.active = 0;
    try { return original.apply(self, args); } finally { state.active = active; state.limit = limit; }
  };
  const wrapped = function (lane, laneState, limit, skipCapped) {
    if (lane !== 'siglip') return original.call(this, lane, laneState, limit, skipCapped);
    const waiters = laneState.waiters;
    tag(waiters);
    // A lost release can never pin the cap: at most every active lease is a native embedding.
    state.active = Math.min(state.active, laneState.activeTotal ?? state.active);
    state.limit = cap();
    if (!(state.active >= state.limit && ready())) { state.held = 0; return plain(this, arguments); }
    const embeds = [], rest = [];
    for (const w of waiters) (isEmbed(w) ? embeds : rest).push(w);
    state.held = embeds.length;
    if (!embeds.length) return plain(this, arguments);
    waiters.length = 0;
    for (const w of rest) waiters.push(w);
    for (const w of embeds) waiters.push(w);
    const admission = getAdmission();
    let reason = null;
    for (const w of rest) {
      const result = admission(lane, w.jobId, limit, w.resourceKey, w.priority);
      if (result === null) return { waiter: w, reason: null };
      reason = result;
      if (!(result === 'resource' && skipCapped)) return { waiter: null, reason: result };
    }
    return { waiter: null, reason: reason ?? 'resource' };
  };
  wrapped.__vfNativeCap = true;
  return wrapped;
}

// Counts the release of a marked native embedding and hands the native release an unboosted lease.
function releaseToken(lane, boosted) {
  if (lane !== 'siglip' || boosted !== TOKEN) return boosted;
  state.active = Math.max(0, state.active - 1);
  state.released += 1;
  return false;
}

function wrapRelease(original) {
  if (original?.__vfNativeCap) return original;
  const wrapped = function (lane, jobId, success, resource, boosted) {
    return original.call(this, lane, jobId, success, resource, releaseToken(lane, boosted));
  };
  wrapped.__vfNativeCap = true;
  return wrapped;
}

module.exports = { NATIVE_EMBEDS, READY_MS, TOKEN, state, configuredLimit, homeReady, tag, wrapDispatch, wrapRelease, releaseToken };
