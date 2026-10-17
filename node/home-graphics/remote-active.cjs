'use strict';
// Counts graphics renders currently executing on the Home PC under a native
// server lease. Such a render uses no server CPU, so the scheduler may admit
// ONE replacement server render for each (render lane + frameshift resource).
// Shared through globalThis: ESM, CJS and hot-loaded copies see one counter.
const MAX_EXTRA = 2;
const state = globalThis.__vfHomeGraphicsRemote ||= { total: 0, byResource: Object.create(null), started: 0, ended: 0 };

function wake() {
  try { globalThis.__vfPcBoostWake?.(); } catch { /* Scheduler wake is best effort. */ }
}

function begin(resource = 'frameshift') {
  if (typeof resource !== 'string' || !resource) throw new TypeError('resource required');
  let open = true;
  state.total++;
  state.byResource[resource] = (state.byResource[resource] || 0) + 1;
  state.started++;
  wake();
  return function end() {
    if (!open) return;
    open = false;
    state.total = Math.max(0, state.total - 1);
    state.byResource[resource] = Math.max(0, (state.byResource[resource] || 0) - 1);
    state.ended++;
    wake();
  };
}

const total = () => Math.min(MAX_EXTRA, state.total);
const active = resource => Math.min(MAX_EXTRA, state.byResource[resource] || 0);
const snapshot = () => ({ total: state.total, byResource: { ...state.byResource }, started: state.started, ended: state.ended });

module.exports = { begin, total, active, snapshot, MAX_EXTRA };
