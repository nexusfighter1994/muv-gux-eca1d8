'use strict';
// Scheduling switches from the PC Boost runtime file (/custom), re-read at most every 2 s.
// earlyPhasePriority: jobs before segment rendering (script, voiceover, audio normalize/cut,
// chunk planning) go first; from segment rendering on the order is finish-first again.
const RUNTIME_PATH = '/data/runtime/pc-boost.json';
const DEFAULTS = Object.freeze({ earlyPhasePriority: true });
let cached = { at: 0, value: DEFAULTS };

function schedulingSettings(now = Date.now(),
  read = () => JSON.parse(require('node:fs').readFileSync(process.env.VF_PC_BOOST_CONFIG || RUNTIME_PATH, 'utf8'))) {
  if (now - cached.at > 2000) {
    let value = DEFAULTS;
    try {
      const file = read();
      value = { earlyPhasePriority: typeof file?.earlyPhasePriority === 'boolean' ? file.earlyPhasePriority : DEFAULTS.earlyPhasePriority };
    } catch { /* defaults */ }
    cached = { at: now, value };
  }
  return cached.value;
}

module.exports = { DEFAULTS, schedulingSettings };
