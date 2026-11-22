'use strict';
// Pod rescue (2026-11-21, owner: "Wieso kamen keine animationen ueber den pod? Fixe das das soll klappen!").
// The app asks the RunPod pool only once, when an animation starts (rendererLane/od -> Dxe -> acquire). If the pod
// is full, booting or gone at that moment, the animation is queued on the local render lane for good. That lane
// sat RAM-blocked (render 0/11, 1300+ waiting), so the pod ran idle and was drained after 5 min while animations
// waited 40+ min. This module keeps every such local wait open to the pod: while it still waits (callback not
// started), a free pod slot takes it (local wait aborted, same call re-run through the app's own pod path).
// Home Motion native recoveries (Home render fell back, mostly > 15 s) are handled the same way.
// Knob (hot, read every 2 s): /data/runtime/vf-pod-rescue.json {"enabled": true, "recovery": true, ...}.
const fs = require('node:fs');

const VERSION = 'pod-rescue-v1';
const FILE = '/data/runtime/vf-pod-rescue.json';
const DEFAULTS = Object.freeze({ enabled: true, recovery: true, workloads: ['animations', 'infographics'],
  tickMs: 2000, settleMs: 4000, spinupMinQueued: 10, maxPerTick: 12, localRecoveries: 2 });

function createSettingsReader(file = FILE, read = p => fs.readFileSync(p, 'utf8'), now = Date.now) {
  let at = -Infinity, value = { ...DEFAULTS };
  return () => {
    const t = now();
    if (t - at < 2000) return value;
    at = t;
    let raw = {};
    try { raw = JSON.parse(read(file)) || {}; } catch { raw = {}; }
    const n = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : d; };
    value = { enabled: raw.enabled !== false, recovery: raw.recovery !== false,
      workloads: Array.isArray(raw.workloads) ? raw.workloads.map(String) : [...DEFAULTS.workloads],
      tickMs: n(raw.tickMs, DEFAULTS.tickMs, 500, 30000), settleMs: n(raw.settleMs, DEFAULTS.settleMs, 0, 60000),
      spinupMinQueued: n(raw.spinupMinQueued, DEFAULTS.spinupMinQueued, 1, 100000),
      maxPerTick: n(raw.maxPerTick, DEFAULTS.maxPerTick, 1, 100),
      localRecoveries: Math.floor(n(raw.localRecoveries, DEFAULTS.localRecoveries, 0, 8)) };
    return value;
  };
}

class RescueAbort extends Error {
  constructor() { super('moved to the RunPod pod (vf-custom pod-rescue)'); this.name = 'AbortError'; this.vfPodRescue = true; }
}

// A wrapped callback must still look like the original to source-based checks (Home Motion renderOnly/validation).
function guarded(fn, state) {
  const g = function (...args) {
    if (state.rescued) throw new RescueAbort();
    state.started = true;
    return Reflect.apply(fn, this, args);
  };
  Object.defineProperty(g, 'toString', { value: () => Function.prototype.toString.call(fn) });
  return g;
}

function anySignal(a, b) {
  if (!a) return b;
  if (!b) return a;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([a, b]) : b;
}

function createRescue(native, { settings = createSettingsReader(), now = Date.now, log = () => {} } = {}) {
  const entries = [];
  const recent = [];
  const stats = { version: VERSION, registered: 0, rescued: 0, local: 0, pod: 0, podFailed: 0, spinups: 0,
    ticks: 0, waiting: 0, lastRescueAt: null, errors: 0 };
  let lastSpin = -Infinity;

  function handles(workload) {
    const cfg = settings();
    return cfg.enabled && cfg.workloads.includes(workload);
  }

  // runLocal(signal, guard) queues the work locally; runPod() runs it through the app's pod path.
  // priority > 0 goes to the pod before older plain waits: Home Motion recoveries hold a Home scope while they wait.
  function race({ jobId, workload, runLocal, runPod, priority = 0 }) {
    const state = { started: false, rescued: false };
    const ac = new AbortController();
    stats.registered++;
    return new Promise((resolve, reject) => {
      const entry = { jobId, workload, priority: Number(priority) || 0, at: now(), state, done: false,
        rescue() {
          if (state.started || state.rescued || entry.done) return false;
          state.rescued = true;
          try { ac.abort(new RescueAbort()); } catch { /* already aborted */ }
          stats.rescued++; stats.lastRescueAt = new Date(now()).toISOString();
          // One grant per moved entry: the pool's acquire wrapper lets only granted calls take a pod slot while
          // entries wait here (runpod-pool.cjs rescueFair), so the order above is the order pods are handed out.
          (globalThis.__vfPodRescueGrants || (globalThis.__vfPodRescueGrants = [])).push(Date.now());
          Promise.resolve().then(runPod).then(v => { entry.done = true; stats.pod++; resolve(v); },
            e => { entry.done = true; stats.podFailed++; reject(e); });
          return true;
        } };
      entries.push(entry);
      let p;
      try { p = Promise.resolve(runLocal(ac.signal, fn => guarded(fn, state))); } catch (e) { p = Promise.reject(e); }
      p.then(v => { if (state.rescued) return; entry.done = true; stats.local++; resolve(v); },
        e => { if (state.rescued) return; entry.done = true; reject(e); });
    });
  }

  function tick() {
    stats.ticks++;
    const cfg = settings();
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].done || entries[i].state.started || entries[i].state.rescued) entries.splice(i, 1);
    stats.waiting = entries.length;
    if (!cfg.enabled || !entries.length) return 0;
    const t = now();
    while (recent.length && t - recent[0] >= cfg.settleMs) recent.shift();
    let free = 0;
    try { free = Math.max(0, Number(native.podFreeSlots()) || 0) - recent.length; } catch (e) { stats.errors++; free = 0; }
    if (free <= 0) {
      try {
        if (!native.podPresent() && entries.length >= cfg.spinupMinQueued && native.poolOn(entries[0].workload)
          && t - lastSpin > 60000) { lastSpin = t; stats.spinups++; native.spinup(entries[0].jobId); }
      } catch (e) { stats.errors++; }
      return 0;
    }
    let moved = 0;
    // Order: flagged entries first, then the app's own job priority (finish-first: the further a video is, the
    // smaller its priority string), then oldest. 21.11. 15:40Z: by age alone the last 44 animations of 4fc5eb4b
    // (1628/1634 for three rounds) stayed behind the 272 new entries of a video that had just started.
    let jobPrio = null;
    try { jobPrio = typeof native.jobPriorities === 'function' ? native.jobPriorities() : null; } catch { jobPrio = null; }
    const pk = e => { const v = jobPrio && jobPrio.get(e.jobId); return v === undefined || v === null ? '~' : String(v); };
    const order = (a, b) => (b.priority || 0) - (a.priority || 0) || (pk(a) < pk(b) ? -1 : pk(a) > pk(b) ? 1 : 0) || a.at - b.at;
    for (const entry of [...entries].sort(order)) {
      if (moved >= Math.min(free, cfg.maxPerTick)) break;
      let on = false;
      try { on = native.poolOn(entry.workload); } catch { on = false; }
      if (!on) continue;
      if (entry.rescue()) { moved++; recent.push(t); }
    }
    if (moved) log(`moved ${moved} waiting render(s) to the pod (${entries.length - moved} still waiting)`);
    return moved;
  }

  return { race, tick, handles, stats: () => ({ ...stats, waiting: entries.filter(e => !e.done && !e.state.started && !e.state.rescued).length }), entries };
}

// rendererLane (od) wrapper: its local branch (pool off, no free pod, no render service) runs through the race.
function wrapRendererLane(orig, rescue, { isRemote }) {
  if (typeof orig !== 'function' || orig.__vfPodRescue) return orig;
  const wrapped = function od(jobId, lane, label, fn, opts = {}) {
    const workload = opts && opts.workload, sched = opts && opts.scheduler;
    if (!jobId || !sched || typeof sched.run !== 'function' || !rescue.handles(workload)) return Reflect.apply(orig, this, [jobId, lane, label, fn, opts]);
    const proxy = Object.create(sched);
    proxy.run = function (j, l, f, o) {
      if (l !== lane || isRemote(workload)) return sched.run(j, l, f, o);
      return rescue.race({ jobId: j, workload,
        runLocal: (signal, guard) => sched.run(j, l, guard(f), { ...(o || {}), signal: anySignal(o && o.signal, signal) }),
        runPod: () => wrapped(j, lane, label, f, opts) });
    };
    return Reflect.apply(orig, this, [jobId, lane, label, fn, { ...opts, scheduler: proxy }]);
  };
  wrapped.__vfPodRescue = VERSION;
  wrapped.original = orig;
  return wrapped;
}

// scheduler.run wrapper for Home Motion native recoveries only (homeKind motion-native-recovery).
function wrapRecoveryRun(scheduler, rescue, { isRemote, dxe, settings = createSettingsReader(), label = 'Custom animation' }) {
  const prev = scheduler.run;
  if (typeof prev !== 'function' || prev.__vfPodRescue) return scheduler;
  const local = { active: 0, podOnly: 0 };
  const wrapped = function (jobId, lane, fn, options) {
    const cfg = settings();
    if (lane !== 'frameshift' || options?.homeKind !== 'motion-native-recovery' || !cfg.enabled || !cfg.recovery
      || !rescue.handles('animations') || isRemote('animations')) return Reflect.apply(prev, this, arguments);
    const self = this;
    const runPod = () => dxe(jobId, label, () => isRemote('animations')
      ? Reflect.apply(prev, self, [jobId, 'gpuFfmpeg', fn, { resourceKey: 'gpuFfmpeg', operation: label, signal: options && options.signal }])
      : Reflect.apply(wrapped, self, [jobId, lane, fn, options]), { workload: 'animations' });
    // 21.11. 14:50Z: a native recovery renders on the server WITHOUT passing the RAM gate. With 16 of them at once
    // (maxRecovering knob) 15 Chromium renders ran locally after the pods lost render, and the server went out of
    // memory twice. At most localRecoveries (2, the old fixed limit) may take the local path; every further one
    // only waits for a pod slot and never starts locally.
    const localMax = Math.max(0, Math.floor(Number(cfg.localRecoveries ?? 2)));
    if (local.active < localMax) {
      local.active++;
      let settled = false;
      const done = () => { if (!settled) { settled = true; local.active--; } };
      const p = rescue.race({ jobId, workload: 'animations', priority: 1, runPod,
        runLocal: (signal, guard) => Reflect.apply(prev, self, [jobId, lane, guard(fn), { ...(options || {}), signal: anySignal(options && options.signal, signal) }]) });
      p.then(done, done);
      return p;
    }
    local.podOnly++;
    return rescue.race({ jobId, workload: 'animations', priority: 1, runPod,
      runLocal: signal => new Promise((resolve, reject) => {
        const stop = sig => reject(sig.reason instanceof Error ? sig.reason : new Error('Home Motion recovery wait aborted'));
        for (const sig of [signal, options && options.signal]) {
          if (!sig) continue;
          if (sig.aborted) { stop(sig); return; }
          sig.addEventListener('abort', () => stop(sig), { once: true });
        }
      }) });
  };
  wrapped.localStats = () => ({ ...local });
  Object.assign(wrapped, prev);
  wrapped.__vfPodRescue = VERSION;
  wrapped.original = prev;
  scheduler.run = wrapped;
  return scheduler;
}

// native: { podFreeSlots, podPresent, poolOn, spinup, dxe, isRemote }, od: { get, set }, scheduler
function install({ native, od, scheduler, log = m => console.log('[vf-pod-rescue] ' + m), setIntervalImpl = setInterval }) {
  if (globalThis.__vfPodRescue) return globalThis.__vfPodRescue;
  const settings = createSettingsReader();
  const rescue = createRescue(native, { settings, log });
  od.set(wrapRendererLane(od.get(), rescue, { isRemote: native.isRemote }));
  wrapRecoveryRun(scheduler, rescue, { isRemote: native.isRemote, dxe: native.dxe, settings });
  const timer = setIntervalImpl(() => { try { rescue.tick(); } catch (e) { rescue.stats().errors++; } }, DEFAULTS.tickMs);
  if (timer && timer.unref) timer.unref();
  const api = { version: VERSION, rescue, tick: rescue.tick, stats: rescue.stats, timer };
  globalThis.__vfPodRescue = api;
  return api;
}

module.exports = { VERSION, FILE, DEFAULTS, createSettingsReader, createRescue, wrapRendererLane, wrapRecoveryRun, install, RescueAbort, guarded };
