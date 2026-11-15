'use strict';
const nativeCap = require('./siglip-native-cap.cjs');

function homeReady(now = Date.now()) {
  try {
    const snapshot = globalThis.__vfHomeSiglipHealth?.snapshot?.();
    return snapshot?.health?.ready === true && snapshot.checkedAt > 0
      && now - snapshot.checkedAt < nativeCap.READY_MS;
  } catch { return false; }
}

function install({queue, scheduler, getState, ready = homeReady, cap = nativeCap.configuredLimit}) {
  if (queue.__vfServerTotalCap) return queue.__vfServerTotalCap;
  const serverView = queue.serverView, queueStats = queue.stats, schedulerStats = scheduler.stats;
  if (![serverView, queueStats, schedulerStats, getState].every(fn => typeof fn === 'function'))
    throw Error('SigLIP total cap dependencies unavailable');
  // A legacy zero embedding setting still needs one counted OCR/recovery slot.
  const limit = () => Math.max(1, Math.min(25, Number(cap()) || 1));
  const guard = {
    version: 1, held: 0, configuredSize: null,
    status() {
      const connected = ready(), home = queueStats.call(queue);
      return {active: Math.max(0, getState().activeTotal - home.active),
        max: connected ? Math.min(guard.configuredSize ?? 25, limit()) : guard.configuredSize,
        homeConnected: connected, configuredMax: guard.configuredSize, held: guard.held};
    },
  };
  // serverView already removes every Home parent lease, including recovering parents.
  // Gate the common admission callback, covering immediate admission AND queued dispatch.
  queue.serverView = function(fn) {
    return serverView.call(this, () => {
      if (ready() && getState().activeTotal >= limit()) { guard.held++; return 'lane'; }
      return fn();
    });
  };
  queue.stats = function(...args) { return {...queueStats.apply(this, args), server: guard.status()}; };
  scheduler.stats = function(...args) {
    const value = schedulerStats.apply(this, args);
    if (value.siglip) {
      guard.configuredSize = value.siglip.size;
      value.siglip.configuredSize = value.siglip.size;
      if (ready()) value.siglip.size = Math.min(value.siglip.size, limit());
    }
    return value;
  };
  queue.__vfServerTotalCap = guard;
  return guard;
}

module.exports = {install, homeReady};
