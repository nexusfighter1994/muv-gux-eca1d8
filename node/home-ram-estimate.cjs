'use strict';
// Server RAM estimates for Home-dispatched work (re-exported by home-queue.mjs; required
// directly for hot installs, because functions created in debugger evaluation run slowly).

// Server RAM one Home dispatch really costs. Measured 2026-10-17 07:25 UTC: 21 ffmpegHome
// leases were served by 12 pc_home_pool consumers holding 1664 MB together (14-309 MB each),
// i.e. ~80 MB per lease; the former 512 MB reserved 10.7 GB and kept the RAM gate shut for
// motion graphics. The live-headroom check (MemAvailable + reserve) still sees real RSS.
const HOME_DISPATCH_MB = 160;
const FALLBACKS = ['ffmpegHomeFallback', 'ffmpegHomeTrimFallback', 'ffmpegHomeNormalizeFallback'];

function wrapHomeRamEstimate(original) {
  if (original.__vfHomeRamVersion === 'home-only-v6') return original;
  const wrapped = function (request = {}) {
    if (FALLBACKS.includes(request.resourceKey)) {
      const composition = request.resourceKey === 'ffmpegHomeFallback';
      const estimate = original.call(this, { ...request, resourceKey: composition ? 'fflowComposition' : 'ffmpeg' });
      return { ...estimate, mb: Math.max(estimate.mb, composition ? 1536 : 512) };
    }
    const estimate = original.call(this, request);
    // Reserve the dispatcher's server RAM, not the PC's rendering RAM; unknown Home keys
    // remain non-learnable. An older wrapper below is overridden for ffmpegHome only.
    return request.resourceKey === 'ffmpegHome' ? { ...estimate, mb: HOME_DISPATCH_MB } : estimate;
  };
  wrapped.__vfHomeRam = true;
  wrapped.__vfHomeRamVersion = 'home-only-v6';
  return wrapped;
}

// Home dispatches cost ~80-160 MB of server RAM and take work OFF the server. They pass the
// admission gate while real available RAM stays above HOME_FLOOR_MB, even when native slots have
// already reserved the gate's headroom (native slots are predicted at ~2.4 GB each); below the
// floor the native gate decides as before.
const HOME_FLOOR_MB = 4096;

function memAvailableMb(read = () => require('node:fs').readFileSync('/proc/meminfo', 'utf8')) {
  try { const m = /MemAvailable:\s+(\d+) kB/.exec(read()); return m ? Number(m[1]) / 1024 : 0; } catch { return 0; }
}

function wrapHomeGate(gate, { available = memAvailableMb, floorMb = HOME_FLOOR_MB } = {}) {
  if (gate?.__vfHomeGate) return gate;
  const wrapped = request => (request?.key === 'ffmpegHome' && available() - HOME_DISPATCH_MB >= floorMb ? true : gate(request));
  wrapped.__vfHomeGate = true;
  return wrapped;
}

module.exports = { wrapHomeRamEstimate, wrapHomeGate, memAvailableMb, HOME_DISPATCH_MB, HOME_FLOOR_MB };
