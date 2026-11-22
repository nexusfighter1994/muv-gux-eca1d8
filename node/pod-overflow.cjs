'use strict';
// vf-custom:pod-overflow-v1 (2026-11-22). Owner: "Immer wenn ein pod läuft hab ich das gefühl das home weniger macht
// geht das irgendwie besser? Dann mach"
//
// While the RunPod pool is on, the app sends every b-roll shot trim through the pod path: the trim waits for a pod
// slot and never reaches the local ffmpeg lane, which is where the Home PC claims its trims. Measured 22.11.:
// Home trims 357 / 268 per 10 min with the pool off, 34 per 10 min with the pool on (pod 767); the Home ffmpeg worker
// fell from 50-90 to 13-28 jobs/min while the pods were 15/16 - 24/24 busy and the ffmpeg lane held 1500-3900 waiters.
//
// Owner rule 21.11. stays: a running pod does every workload it can. So the pod keeps first call: a trim goes to the
// local lane (and from there to Home) only while every pod slot is busy AND a backlog already waits for the pod.
// Home must be reachable and must not have its own trims piling up. Everything else is unchanged.
const fs = require('node:fs');

const DEFAULTS = { enabled: true, minPodWaiters: 4, waiterFactor: 0.5, maxHomeQueued: 6, maxLocal: 32 };
const KNOB = '/data/runtime/vf-pod-overflow.json';
const WORKLOAD = 'brollAnalysis';
const OPERATION = 'B-roll shot trim';   // also "B-roll shot trim (footage reuse)"

function readKnob(file = KNOB, read = p => fs.readFileSync(p, 'utf8')) {
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(read(file));
    if (raw && raw.enabled === false) out.enabled = false;
    for (const [key, min, max] of [['minPodWaiters', 0, 500], ['maxHomeQueued', 1, 200], ['maxLocal', 1, 200]]) {
      const v = Number(raw && raw[key]);
      if (Number.isInteger(v) && v >= min && v <= max) out[key] = v;
    }
    const f = Number(raw && raw.waiterFactor);
    if (Number.isFinite(f) && f >= 0 && f <= 10) out.waiterFactor = f;
  } catch { /* no file = defaults */ }
  return out;
}

// Returns 'home' (run on the local lane, Home claims it there) or the reason the trim stays on the pod path.
function decide({ cfg, workload, operation, remote, poolOn, podFree, podSlots, podWaiters, homeCapacity, homeActive, homeQueued, localInFlight }) {
  if (!cfg.enabled) return 'off';
  if (workload !== WORKLOAD || !String(operation || '').startsWith(OPERATION)) return 'other work';
  if (remote || !poolOn) return 'native';
  if (podFree > 0) return 'pod free';
  if (podWaiters < Math.max(cfg.minPodWaiters, Math.ceil(podSlots * cfg.waiterFactor))) return 'pod queue short';
  if (!(homeCapacity > 0)) return 'home away';
  if (homeActive >= homeCapacity) return 'home full';
  if (homeQueued >= cfg.maxHomeQueued) return 'home queue';
  if (localInFlight >= cfg.maxLocal) return 'local limit';
  return 'home';
}

function createPodOverflow({ isRemote, poolOn, pods, slotsOf, waiters, homeStats, settings = () => readKnob(), now = () => Date.now() }) {
  const stats = { home: 0, pod: {}, localInFlight: 0, localDone: 0, localFailed: 0, localAvgSec: 0, lastHomeAt: null, errors: 0, since: new Date(now()).toISOString() };
  let cfgAt = -Infinity, cfg = { ...DEFAULTS };
  let homeAt = -Infinity, home = { capacity: 0, active: 0, queued: 0 };

  const config = () => {
    if (now() - cfgAt >= 2000) { cfgAt = now(); try { cfg = settings() || { ...DEFAULTS }; } catch { cfg = { ...DEFAULTS }; } }
    return cfg;
  };
  // The Home queue stats walk every ffmpeg waiter (thousands), so read them at most once a second. Trims this module
  // sent since the last read are added, otherwise a burst inside one second would pass the queue check unseen.
  let sentSinceRead = 0;
  const homeState = () => {
    if (now() - homeAt >= 1000) {
      homeAt = now(); sentSinceRead = 0;
      const s = homeStats() || {};
      home = { capacity: Number(s.capacity) || 0, active: Number(s.active) || 0, queued: Number(s.queuedKinds && s.queuedKinds['video-trim']) || 0 };
    }
    return { ...home, queued: home.queued + sentSinceRead };
  };
  const podState = () => {
    let slots = 0, free = 0;
    for (const p of pods() || []) {
      if (!p || p.state !== 'ready' || (p.capabilities && p.capabilities.fflow === false)) continue;
      const s = Math.max(0, Number(slotsOf(p)) || 0);
      slots += s; free += Math.max(0, s - (Number(p.inflight) || 0));
    }
    return { slots, free };
  };

  function shouldRunLocal({ jobId, operation, workload }) {
    try {
      const c = config();
      // Cheap exits first: everything that is not a b-roll trim never touches the pool or Home state.
      if (!c.enabled || !jobId || workload !== WORKLOAD || !String(operation || '').startsWith(OPERATION)) return false;
      const remote = !!isRemote(), on = !remote && !!poolOn(workload);
      let pod = { slots: 0, free: 0 }, h = { capacity: 0, active: 0, queued: 0 }, podWaiters = 0;
      if (on) { pod = podState(); podWaiters = Number(waiters()) || 0; if (pod.free === 0) h = homeState(); }
      const why = decide({ cfg: c, workload, operation, remote, poolOn: on, podFree: pod.free, podSlots: pod.slots, podWaiters,
        homeCapacity: h.capacity, homeActive: h.active, homeQueued: h.queued, localInFlight: stats.localInFlight });
      if (why === 'home') { stats.home += 1; stats.lastHomeAt = new Date(now()).toISOString(); sentSinceRead += 1; return true; }
      stats.pod[why] = (stats.pod[why] || 0) + 1;
      return false;
    } catch { stats.errors += 1; return false; }
  }

  async function runLocal(fn) {
    const t0 = now();
    stats.localInFlight += 1;
    try {
      const result = await fn();
      stats.localDone += 1;
      const sec = (now() - t0) / 1000;
      stats.localAvgSec = Math.round((stats.localAvgSec + (sec - stats.localAvgSec) / Math.min(stats.localDone, 200)) * 10) / 10;
      return result;
    } catch (e) { stats.localFailed += 1; throw e; }
    finally { stats.localInFlight -= 1; }
  }

  return { shouldRunLocal, runLocal, stats };
}

module.exports = { createPodOverflow, decide, readKnob, DEFAULTS, KNOB, WORKLOAD, OPERATION };
