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

module.exports = { wrapHomeRamEstimate, HOME_DISPATCH_MB };
