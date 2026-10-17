export const mapAdmissionStats = { released: 0, lastAt: null, lastJobId: null };

export function wrapMapAdmissionCheck(original, getState) {
  function guarded(lane, jobId, limit, resource = lane) {
    const reason = original.apply(this, arguments);
    if (reason !== 'reservation' || lane !== 'render' || resource !== 'geomap') return reason;
    const state = getState();
    if (!state || state.lane.activeTotal !== 0 || state.activeMap?.jobId !== jobId
        || state.activeMap.phase !== 'scheduler_wait' || state.activeMap.cancelled) return reason;

    // The single admitted map holds the map queue. Reservations belonging to maps
    // behind it cannot run until it releases that queue; lend one idle render slot.
    if (state.lane.waiters.some(waiter => original.call(this, lane, waiter.jobId, limit,
      waiter.resourceKey, waiter.priority) === null)) return reason;
    mapAdmissionStats.released += 1;
    mapAdmissionStats.lastAt = new Date().toISOString();
    mapAdmissionStats.lastJobId = jobId;
    return null;
  }
  Object.defineProperties(guarded, {
    originalAdmissionCheck: { value: original },
    mapAdmissionVersion: { value: 'idle-map-reservation-v1' },
  });
  return guarded;
}

export function wrapMapWaiterChoice(original, canAdmit) {
  function choose(lane, state, limit) {
    const result = original.apply(this, arguments);
    if (lane !== 'render' || result.waiter || result.reason !== 'reservation' || state.activeTotal !== 0) return result;
    const waiter = state.waiters.find(item => item.resourceKey === 'geomap'
      && canAdmit(lane, item.jobId, limit, item.resourceKey, item.priority) === null);
    return waiter ? { waiter, reason: null } : result;
  }
  Object.defineProperty(choose, 'mapWaiterVersion', { value: 'idle-map-reservation-v1' });
  return choose;
}
