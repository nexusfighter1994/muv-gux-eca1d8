import { wrapRenderAdmissionCheck, wrapRenderWaiterChoice } from './render-admission.mjs';

export const mapAdmissionStats = { released: 0, lastAt: null, lastJobId: null };

export function wrapMapAdmissionCheck(original, getState) {
  function guarded(lane, jobId, limit, resource = lane, priority) {
    const reason = original.apply(this, arguments);
    if (reason !== 'reservation' || lane !== 'render' || resource !== 'geomap') return reason;
    const state = getState();
    if (!state || !Number.isFinite(limit) || !Number.isFinite(state.lane?.activeTotal)
        || state.lane.activeTotal < 0 || state.lane.activeTotal >= limit
        || !Array.isArray(state.lane.waiters) || state.activeMap?.jobId !== jobId
        || state.activeMap.phase !== 'scheduler_wait' || state.activeMap.cancelled) return reason;

    const partial = state.lane.activeTotal > 0;
    if (partial && (typeof priority !== 'string' || !state.lane.waiters.some(waiter =>
      waiter.jobId === jobId && waiter.resourceKey === resource && waiter.priority === priority))) return reason;

    // The serial map head may borrow counted spare capacity beside capped work.
    // Preserve ready earlier work, native per-resource caps, and the RAM gate.
    if (state.lane.waiters.some(waiter => {
      const earlierReason = original.call(this, lane, waiter.jobId, limit,
        waiter.resourceKey, waiter.priority);
      return earlierReason === null || partial && waiter.jobId !== jobId
        && (typeof waiter.priority !== 'string' || waiter.priority < priority && earlierReason === 'reservation');
    })) return reason;
    mapAdmissionStats.released += 1;
    mapAdmissionStats.lastAt = new Date().toISOString();
    mapAdmissionStats.lastJobId = jobId;
    return null;
  }
  Object.defineProperties(guarded, {
    originalAdmissionCheck: { value: original },
    mapAdmissionVersion: { value: 'partial-map-reservation-v2' },
  });
  return wrapRenderAdmissionCheck(guarded, (jobId, priority) => {
    const state = getState();
    return { lane: state?.lane, priority: priority ?? state?.lane?.waiters
      .find(waiter => waiter.jobId === jobId)?.priority };
  });
}

export function wrapMapWaiterChoice(original, canAdmit) {
  function choose(lane, state, limit) {
    const result = original.apply(this, arguments);
    if (lane !== 'render' || !result || result.waiter || !['resource', 'reservation'].includes(result.reason)
        || !Number.isFinite(limit) || !Number.isFinite(state?.activeTotal)
        || state.activeTotal < 0 || state.activeTotal >= limit || !Array.isArray(state.waiters)) return result;
    const waiter = state.waiters.find(item => item.resourceKey === 'geomap'
      && canAdmit(lane, item.jobId, limit, item.resourceKey, item.priority) === null);
    return waiter ? { waiter, reason: null } : result;
  }
  Object.defineProperty(choose, 'mapWaiterVersion', { value: 'partial-map-reservation-v2' });
  return wrapRenderWaiterChoice(choose, canAdmit);
}
