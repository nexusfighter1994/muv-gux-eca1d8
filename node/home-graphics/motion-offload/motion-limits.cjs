'use strict';
// Home motion limits as published in the PC Boost runtime file (pc-boost-api motionSlots /
// motionHomeShare). Invalid or missing values fall back to the previous fixed behaviour.
const LIMITS = Object.freeze({
  motionSlots: Object.freeze({ min: 1, max: 4, fallback: 2 }),
  motionHomeShare: Object.freeze({ min: 50, max: 200, fallback: 70 }),
});

function motionLimits(config) {
  const out = {};
  for (const [key, { min, max, fallback }] of Object.entries(LIMITS)) {
    const value = config && typeof config === 'object' ? config[key] : undefined;
    out[key] = Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
  }
  return out;
}

// For a route rebuilt inside a running server whose motion configuration predates the
// limits: getSettings additionally reports them, read from the runtime file per call.
function withMotionLimits(getConfig, runtimePath = '/data/runtime/pc-boost.json', readFile = require('node:fs').readFileSync) {
  return () => {
    const c = getConfig();
    if (!c) return c;
    return { ...c, getSettings: () => {
      let file = null;
      try { file = JSON.parse(readFile(runtimePath, 'utf8')); } catch { /* defaults */ }
      return { ...(typeof c.getSettings === 'function' ? c.getSettings() : {}), ...motionLimits(file) };
    } };
  };
}

module.exports = { LIMITS, motionLimits, withMotionLimits };
