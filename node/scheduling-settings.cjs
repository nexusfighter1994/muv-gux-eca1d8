'use strict';
// Scheduling switches from the PC Boost runtime file (/custom), re-read at most every 2 s.
// earlyPhasePriority: jobs before segment rendering (script, voiceover, audio normalize/cut,
// chunk planning) go first; from segment rendering on the order is finish-first again.
// shortVideoPriority (2026-11-19): while rendering segments, videos with at most
// shortVideoMaxSegments segments rank before long videos that are still rendering segments
// (job-priority.cjs). Own knob file, because the /custom page rewrites pc-boost.json.
const RUNTIME_PATH = '/data/runtime/pc-boost.json';
const SHORT_PATH = '/data/runtime/vf-short-video-priority.json';
const DEFAULTS = Object.freeze({ earlyPhasePriority: true, shortVideoPriority: true, shortVideoMaxSegments: 400 });
let cached = { at: 0, value: DEFAULTS };

function readJson(path) { return JSON.parse(require('node:fs').readFileSync(path, 'utf8')); }

function schedulingSettings(now = Date.now(),
  read = () => readJson(process.env.VF_PC_BOOST_CONFIG || RUNTIME_PATH),
  readShort = () => readJson(process.env.VF_SHORT_VIDEO_PRIORITY_CONFIG || SHORT_PATH)) {
  if (now - cached.at > 2000) {
    let early = DEFAULTS.earlyPhasePriority, short = DEFAULTS.shortVideoPriority, max = DEFAULTS.shortVideoMaxSegments;
    try {
      const file = read();
      if (typeof file?.earlyPhasePriority === 'boolean') early = file.earlyPhasePriority;
    } catch { /* defaults */ }
    try {
      const file = readShort();
      if (typeof file?.enabled === 'boolean') short = file.enabled;
      const n = Number(file?.maxSegments);
      if (Number.isFinite(n) && n >= 1 && n <= 100000) max = Math.floor(n);
    } catch { /* defaults */ }
    cached = { at: now, value: { earlyPhasePriority: early, shortVideoPriority: short, shortVideoMaxSegments: max } };
  }
  return cached.value;
}

module.exports = { DEFAULTS, schedulingSettings };
