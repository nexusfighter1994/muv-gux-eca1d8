'use strict';
// vf-custom:small-steps-v1 (2026-11-13)
// The last ffmpeg-lane step of a b_roll_video segment before its credit render is the black-bar
// detection (brollVideo.renderSegment: scheduler.run(job,'ffmpeg',()=>detectBars(clip))). It needs
// 2-9 s, but it queued like every other untagged b_roll_video ffmpeg call behind thousands of
// candidate scene analyses. On 2026-11-13 it waited 5673-5976 s: 264 finished final cuts stood
// still for 100 min and came through as one block (828 in 10 min) once the chunk compositions of
// the leading video were done. Owner: keep room for the small steps so they are always worked off.
//
// Such a call now gets
//   1. the scheduler's interactive priority, which sorts before every job priority in the native
//      grant loop (and no job reservation counts against it),
//   2. its own resource key with a 256 MB estimate (home-ram-estimate.cjs) instead of the learned
//      1.1-2.2 GB of ffmpeg:b_roll_video, and
//   3. a gate pass while real MemAvailable stays above a floor, so app_budget / live_headroom /
//      render-turn refusals aimed at multi-GB slots do not hold a 2-9 s probe.
// It still takes one of the ffmpeg lane's slots and is not offered to the Home queue (own homeKind).
//
// Switch, read once per second, no restart: /data/runtime/vf-small-steps.json {"enabled":true}.
// A missing or invalid file means off, so an API restart alone changes nothing.
const fs = require('node:fs');
const homeRam = require('./home-ram-estimate.cjs');

const VERSION = 'small-steps-v1';
const FILE = '/data/runtime/vf-small-steps.json';
const SMALL_RESOURCE = 'ffmpegSmall';
const SMALL_KIND = 'small-native';
const SMALL_OPERATION = 'small-bar-detect';
const SMALL_MB = 256;
const FLOOR_MB = 4096;
const INSTALLED = Symbol.for('vidforge.small-steps.installed');

// Exact source of the callback in the current bundle, plus its shape for other minifier names.
const BAR_DETECT_SOURCES = ['()=>(u.detectBars||CKe)(me.clipPath,{durationSec:z})'];
const ID = '[a-zA-Z_$][\\w$]*';
const BAR_DETECT_SHAPE = new RegExp(`^\\(\\)=>\\(${ID}\\.detectBars\\|\\|${ID}\\)\\(${ID}\\.clipPath,\\{durationSec:${ID}\\}\\)$`);

function isSmallStepCallback(callback) {
  if (typeof callback !== 'function') return false;
  const source = String(callback);
  return BAR_DETECT_SOURCES.includes(source) || BAR_DETECT_SHAPE.test(source);
}

function createSettingsReader({ file = FILE, now = Date.now, read = path => fs.readFileSync(path, 'utf8') } = {}) {
  let checked = -Infinity, value = { enabled: false, floorMb: FLOOR_MB };
  return () => {
    const at = now();
    if (at >= checked && at - checked < 1000) return value;
    checked = at;
    let raw = null;
    try { raw = JSON.parse(read(file)); } catch { raw = null; }
    const floor = Number(raw?.floorMb);
    value = { enabled: raw?.enabled === true,
      floorMb: Number.isFinite(floor) && floor >= 2048 && floor <= 32768 ? floor : FLOOR_MB };
    return value;
  };
}

// A call another module already routed (own homeKind or resource key) is left alone.
function tagSmallStep(options) {
  if (options?.homeKind || options?.resourceKey) return options;
  return { ...options, interactive: true, resourceKey: SMALL_RESOURCE, homeKind: SMALL_KIND,
    operation: options?.operation || SMALL_OPERATION };
}

const SKIP_PROPS = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);
function keepProps(target, source) {
  for (const name of Object.getOwnPropertyNames(source)) {
    if (SKIP_PROPS.has(name) || Object.hasOwn(target, name)) continue;
    try { target[name] = source[name]; } catch {}
  }
  return target;
}

function wrapSmallGate(gate, { available = homeRam.memAvailableMb, settings = createSettingsReader(), stats = {} } = {}) {
  if (typeof gate !== 'function') throw new TypeError('gate must be a function');
  if (gate.__vfSmallGate === VERSION) return gate;
  const wrapped = function (request) {
    if (request?.key === SMALL_RESOURCE) {
      const current = settings();
      if (current.enabled) {
        const free = Number(available());
        if (Number.isFinite(free) && free - SMALL_MB >= current.floorMb) {
          stats.gatePassed = (stats.gatePassed || 0) + 1;
          return true;
        }
        stats.gateDeferred = (stats.gateDeferred || 0) + 1;
      }
    }
    return gate.call(this, request);
  };
  wrapped.__vfSmallGate = VERSION;
  // Observers of inner wrappers (getStats, snapshot, headroomStats, version flags) stay reachable.
  return keepProps(wrapped, gate);
}

function install({ scheduler, settings = createSettingsReader(), available = homeRam.memAvailableMb } = {}) {
  if (!scheduler || typeof scheduler.run !== 'function') throw new TypeError('scheduler.run is required');
  if (scheduler[INSTALLED]) return scheduler[INSTALLED];
  const stats = { version: VERSION, tagged: 0, leftAlone: 0, off: 0, gatePassed: 0, gateDeferred: 0, lastAt: null };
  // Later installers may put their own gate on top; the pass has to be the outermost check.
  const ensureGate = () => {
    if (typeof scheduler.getMemoryGate !== 'function' || typeof scheduler.setMemoryGate !== 'function') return;
    const gate = scheduler.getMemoryGate();
    if (typeof gate === 'function' && gate.__vfSmallGate !== VERSION) scheduler.setMemoryGate(wrapSmallGate(gate, { available, settings, stats }));
  };
  const originalRun = scheduler.run;
  const run = function (jobId, resource, callback, options) {
    if (resource === 'ffmpeg' && isSmallStepCallback(callback)) {
      if (!settings().enabled) stats.off++;
      else {
        const tagged = tagSmallStep(options);
        if (tagged === options) stats.leftAlone++;
        else {
          try { ensureGate(); } catch {}
          stats.tagged++; stats.lastAt = new Date().toISOString();
          options = tagged;
        }
      }
    }
    return originalRun.call(this, jobId, resource, callback, options);
  };
  keepProps(run, originalRun);
  run.__vfSmallSteps = VERSION;
  scheduler.run = run;
  const api = { version: VERSION, stats, settings: () => settings() };
  Object.defineProperty(scheduler, INSTALLED, { value: api, configurable: true });
  globalThis.__vfSmallSteps = api;
  return api;
}

module.exports = { install, wrapSmallGate, tagSmallStep, isSmallStepCallback, createSettingsReader,
  VERSION, FILE, SMALL_RESOURCE, SMALL_KIND, SMALL_OPERATION, SMALL_MB, FLOOR_MB, BAR_DETECT_SOURCES };
