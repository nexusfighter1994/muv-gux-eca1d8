'use strict';
// Short FFmpeg steps that hold up a whole job get the scheduler's interactive priority (front of
// the lane) instead of the job's finish-first rank. Cutting the voiceover into the chunk
// voiceovers ("Cutting N voiceovers") is many sub-second audio cuts; ranked like the rest of a
// young job they waited behind hundreds of render-side FFmpeg operations.
const PATTERNS = Object.freeze([
  Object.freeze({
    name: 'voiceover-cut', lane: 'ffmpeg',
    source: /^\(\)=>[\w$]+\(\{source:[\w$]+,prepared:!0,targetPath:[\w$]+,startTime:[\w$]+\.start_time,endTime:[\w$]+\.end_time[,}]/,
  }),
]);
const { schedulingSettings } = require('./scheduling-settings.cjs');
const stats = globalThis.__vfOpPriority ||= { boosted: 0, byName: {}, installedAt: null };

function match(lane, callback) {
  if (typeof callback !== 'function') return null;
  const source = String(callback);
  for (const p of PATTERNS) if (p.lane === lane && p.source.test(source)) return p.name;
  return null;
}

// Follows the /custom switch earlyPhasePriority (these steps are early-phase work).
function wrapRun(run, enabled = () => schedulingSettings().earlyPhasePriority === true) {
  if (run?.__vfOpPriority) return run;
  const wrapped = function (jobId, lane, callback, options) {
    const name = lane === 'ffmpeg' && options?.interactive !== true ? match(lane, callback) : null;
    if (name && enabled()) {
      stats.boosted += 1;
      stats.byName[name] = (stats.byName[name] || 0) + 1;
      options = { ...options, interactive: true };
    } else if (name && run.__vfOpPriorityInner) {
      // Switched off: an earlier hot-installed op wrapper inside must not recognise the step.
      const original = callback;
      callback = () => original();
    }
    return run.call(this, jobId, lane, callback, options);
  };
  // Keep the markers other installers check on scheduler.run (e.g. __vfHomeDirect).
  for (const key of Object.keys(run)) wrapped[key] = run[key];
  delete wrapped.__vfOpPriorityInner;
  wrapped.__vfOpPriority = true;
  return wrapped;
}

// The scheduler exists once the native module has initialised it; retry until then.
function installOpPriority(getScheduler, { schedule = fn => setInterval(fn, 1000) } = {}) {
  const attempt = () => {
    let scheduler = null;
    try { scheduler = getScheduler(); } catch { return false; }
    if (typeof scheduler?.run !== 'function') return false;
    scheduler.run = wrapRun(scheduler.run);
    stats.installedAt ||= new Date().toISOString();
    return true;
  };
  if (attempt()) return stats;
  const timer = schedule(() => { if (attempt()) clearInterval(timer); });
  timer?.unref?.();
  return stats;
}

module.exports = { PATTERNS, stats, match, wrapRun, installOpPriority };
