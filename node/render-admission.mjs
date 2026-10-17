const ADMISSION_VERSION = 'ready-render-reservation-v1';
const CHOOSER_VERSION = 'ready-render-waiter-v1';
const supported = resource => resource === 'remotion' || resource === 'frameshift';

function idleCapacity(lane, cap) {
  return Number.isFinite(cap) && Number.isFinite(lane?.activeTotal)
    && lane.activeTotal >= 0 && lane.activeTotal < cap && Array.isArray(lane.waiters);
}

function preserveDescriptors(target, original) {
  for (const key of Reflect.ownKeys(original)) {
    // Function identity belongs to the wrapper; preserve all extension metadata.
    if (['name', 'length', 'prototype', 'caller', 'arguments'].includes(key)
        || Object.hasOwn(target, key)) continue;
    Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(original, key));
  }
  return target;
}

export function wrapRenderAdmissionCheck(original, getState) {
  if (original.renderAdmissionVersion === ADMISSION_VERSION) return original;
  function guarded(lane, jobId, limit, resource = lane, priority) {
    const reason = original.apply(this, arguments);
    if (reason !== 'reservation' || lane !== 'render' || !supported(resource)) return reason;
    const state = getState.call(this, jobId, priority);
    if (!idleCapacity(state?.lane, limit) || typeof state.priority !== 'string'
        || (priority !== undefined && priority !== state.priority)) return reason;
    const waiters = state.lane.waiters;
    if (!waiters.some(w => w?.jobId === jobId && w.priority === state.priority
        && w.resourceKey === resource)) return reason;

    // Only ready higher-priority work that passes every non-reservation guard
    // keeps its reservation. Future demand alone cannot strand counted slots.
    const args = Array.from(arguments);
    for (const w of waiters) {
      if (!w || typeof w.priority !== 'string') return reason;
      if (w.priority >= state.priority) continue;
      const earlierArgs = args.slice();
      earlierArgs[1] = w.jobId;
      earlierArgs[3] = w.resourceKey || lane;
      earlierArgs[4] = w.priority;
      const earlierReason = original.apply(this, earlierArgs);
      if (earlierReason === null || earlierReason === 'reservation') return reason;
    }
    return null;
  }
  Object.defineProperties(guarded, {
    renderAdmissionVersion: { value: ADMISSION_VERSION },
    originalRenderAdmissionCheck: { value: original },
  });
  return preserveDescriptors(guarded, original);
}

export function wrapRenderWaiterChoice(original, canAdmit) {
  if (original.renderWaiterVersion === CHOOSER_VERSION) return original;
  function choose(lane, state, limit) {
    const result = original.apply(this, arguments);
    if (lane !== 'render' || !result || result.waiter
        || !['resource', 'reservation'].includes(result.reason)
        || !idleCapacity(state, limit)) return result;
    for (const waiter of state.waiters) {
      if (!waiter || !supported(waiter.resourceKey)) continue;
      if (canAdmit.call(this, lane, waiter.jobId, limit, waiter.resourceKey, waiter.priority) === null) {
        return { ...result, waiter, reason: null };
      }
    }
    return result;
  }
  Object.defineProperties(choose, {
    renderWaiterVersion: { value: CHOOSER_VERSION },
    originalRenderWaiterChoice: { value: original },
  });
  return preserveDescriptors(choose, original);
}
