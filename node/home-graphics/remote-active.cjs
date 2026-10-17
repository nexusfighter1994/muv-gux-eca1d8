'use strict';
// Counts graphics renders currently executing on the Home PC under a native
// server lease. Such a render uses no server CPU, so the scheduler may admit
// ONE replacement server render for each (render lane + frameshift resource). While the
// frameshift route reports that Home could take one more, ONE extra render is admitted
// (a probe) so idle Home slots are filled without waiting for a server slot.
// Shared through globalThis: ESM, CJS and hot-loaded copies see one counter.
const MAX_EXTRA = 4;
const state = globalThis.__vfHomeGraphicsRemote ||= { total: 0, byResource: Object.create(null), started: 0, ended: 0 };

function wake() {
  try { globalThis.__vfPcBoostWake?.(); } catch { /* Scheduler wake is best effort. */ }
}

// A render on the Home PC needs (almost) no server RAM, but its native lease keeps the full
// estimate in the RAM gate (globalThis.__vfRamAllocations, ram-allocations-install.py), so
// other lanes waited for phantom memory. While remote, the newest full-estimate frameshift
// allocation is lowered to REMOTE_MB; end() restores it (a fallback renders on the server).
const REMOTE_MB = 256;
function lowerAllocation(resource) {
  const table = globalThis.__vfRamAllocations;
  if (resource !== 'frameshift' || !(table instanceof Map)) return null;
  let pick = null;
  for (const entry of table.values()) {
    if (entry && entry.laneKey === 'render' && entry.resourceKey === 'frameshift' && !entry.vfRemote
      && Number.isFinite(entry.estimateMb) && entry.estimateMb > REMOTE_MB && (!pick || entry.grantedAtMs > pick.grantedAtMs)) pick = entry;
  }
  if (!pick) return null;
  const original = pick.estimateMb;
  pick.estimateMb = REMOTE_MB;
  pick.vfRemote = true;
  state.loweredMb = (state.loweredMb || 0) + original - REMOTE_MB;
  return () => {
    pick.estimateMb = original;
    delete pick.vfRemote;
    state.loweredMb = Math.max(0, (state.loweredMb || 0) - (original - REMOTE_MB));
  };
}

function begin(resource = 'frameshift') {
  if (typeof resource !== 'string' || !resource) throw new TypeError('resource required');
  let open = true;
  let restore = null;
  try { restore = lowerAllocation(resource); } catch { restore = null; }
  state.total++;
  state.byResource[resource] = (state.byResource[resource] || 0) + 1;
  state.started++;
  wake();
  return function end() {
    if (!open) return;
    open = false;
    try { restore?.(); } catch { /* the lease may be gone already */ }
    state.total = Math.max(0, state.total - 1);
    state.byResource[resource] = Math.max(0, (state.byResource[resource] || 0) - 1);
    state.ended++;
    wake();
  };
}

function setOfferable(fn) { state.offerable = typeof fn === 'function' ? fn : null; }
const probe = resource => {
  if (resource !== 'frameshift' || typeof state.offerable !== 'function') return 0;
  try { return state.offerable() === true ? 1 : 0; } catch { return 0; }
};
const total = () => Math.min(MAX_EXTRA, state.total + probe('frameshift'));
const active = resource => Math.min(MAX_EXTRA, (state.byResource[resource] || 0) + probe(resource));
const snapshot = () => ({ total: state.total, byResource: { ...state.byResource }, started: state.started, ended: state.ended, loweredMb: state.loweredMb || 0 });

module.exports = { begin, total, active, snapshot, setOfferable, MAX_EXTRA, REMOTE_MB };
