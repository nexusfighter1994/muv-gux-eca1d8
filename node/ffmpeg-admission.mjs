export const ffmpegAdmissionStats = { allowedChecks: 0, lastAt: null, lastJobId: null };

export function wrapFfmpegAdmissionCheck(original, getState) {
  if (original.ffmpegAdmissionVersion === 'ready-ffmpeg-reservation-v1') return original;
  function guarded(lane, jobId, limit, resource = lane, priority) {
    const reason = original.apply(this, arguments);
    if (reason !== 'reservation' || lane !== 'ffmpeg') return reason;
    const state = getState(jobId, priority);
    if (!state?.lane || !Number.isFinite(limit) || state.lane.activeTotal >= limit
        || typeof state.priority !== 'string' || !Array.isArray(state.lane.waiters)) return reason;
    const waiters = state.lane.waiters;
    if (!waiters.some(w => w.jobId === jobId && w.priority === state.priority
        && (w.resourceKey || lane) === resource)) return reason;

    // Future demand may reserve every slot while its inputs are still being prepared.
    // Ready tasks can borrow idle slots, with ready higher-priority tasks admitted first.
    if (waiters.some(w => {
      if (w.priority >= state.priority) return false;
      const earlierReason = original.call(this, lane, w.jobId, limit, w.resourceKey, w.priority);
      return earlierReason === null || earlierReason === 'reservation';
    })) return reason;
    ffmpegAdmissionStats.allowedChecks += 1;
    ffmpegAdmissionStats.lastAt = new Date().toISOString();
    ffmpegAdmissionStats.lastJobId = jobId;
    return null;
  }
  Object.defineProperties(guarded, {
    originalFfmpegAdmissionCheck: { value: original },
    ffmpegAdmissionVersion: { value: 'ready-ffmpeg-reservation-v1' },
  });
  for (const key of ['mapAdmissionVersion', 'originalAdmissionCheck']) {
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor) Object.defineProperty(guarded, key, descriptor);
  }
  return guarded;
}
