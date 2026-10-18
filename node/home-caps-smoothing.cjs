'use strict';
// HOT-ONLY shim for a server that started before pc-boost-api/home-queue tolerated a loaded event
// loop: globalThis.__vfHomeCapabilities keeps the last ready Home capabilities through up to 2
// failed probes and reports them as current while the last success is under 45 s old (the running
// home-queue admission still rejects data older than 15 s). Fresh code does this natively.
function installHomeCapsSmoothing({ now = Date.now, toleranceMs = 45000, maxFailures = 2 } = {}) {
  if (globalThis.__vfHomeCapsSmoothing) return globalThis.__vfHomeCapsSmoothing;
  let raw = globalThis.__vfHomeCapabilities, good = raw?.ready ? raw : null, failures = 0;
  const stats = { sets: 0, smoothed: 0, failures: 0 };
  Object.defineProperty(globalThis, '__vfHomeCapabilities', {
    configurable: true,
    get() {
      const base = raw?.ready ? raw : (good && failures <= maxFailures ? good : null);
      if (base && now() - base.checkedAt < toleranceMs) {
        if (base !== raw || now() - base.checkedAt > 15000) stats.smoothed++;
        return { ...base, checkedAt: now() };
      }
      return raw;
    },
    set(value) {
      stats.sets++;
      raw = value;
      if (value?.ready) { good = value; failures = 0; } else { failures++; stats.failures++; }
    },
  });
  return (globalThis.__vfHomeCapsSmoothing = stats);
}
module.exports = { installHomeCapsSmoothing };
