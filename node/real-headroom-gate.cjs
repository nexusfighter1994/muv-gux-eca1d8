'use strict';
// Native app_budget admits a slot only while baseline + the sum of learned PEAK estimates of every
// running slot fits the budget. Peaks never coincide and Home dispatches (160 MB each) barely use
// server RAM, so on 2026-11-05 00:00-05:00 UTC the ffmpeg lane and Home recoveries waited on
// app_budget while 18-29 GB were really free: Home scopes stayed held, 8,111 trims piled up.
// An app_budget refusal is admitted while real free RAM after this slot (minus slots admitted here
// recently) stays above the floor. pressure, live_headroom and render_fair_turn stay native.
// Off switch without restart: /data/runtime/vf-real-headroom.json {"enabled":false}.
const fs = require('node:fs');

const VERSION = 'real-headroom-v5';
// v2: many small ffmpeg admissions took every bit of headroom and starved the render lane (0/6,
// 2026-11-05 06:27). While a render refusal is recent, other lanes must leave room for that slot.
// v3: native pendingMb already holds the slots admitted here until they warm up (<= ~8 s), so
// subtracting pending AND the recent admissions counted them twice (11:07: 31 GB really free,
// server ffmpeg kept at 4/16). The larger of the two still covers slots whose RSS lags behind.
// v4: the recent window is a runtime setting (recentMs 5-60 s, default 20 s). Native pending holds a
// slot for its ~8 s warm-up; 20 s of grants still blocked siglip/search/render with 28 GB really
// free (2026-11-07). Tunable live via the settings file instead of an API restart.
// v5: native pending = full learned PEAK of every slot granted in the last 15 s. Short slots (SigLIP
// 2.1 GB, trims 3.4 GB, renders 4 GB) churn, so pending stayed ~25-31 GB while MemAvailable was
// 30 GB and memPsi 0 (2026-11-07 08:47Z: ffmpeg 6/16 with 140 queued). Runtime pendingShare
// (0.1-1, default 1 = v4) counts only that share of it; real free RAM and the floor still decide.
const RENDER_HOLD_MS = 15000;
const FILE = '/data/runtime/vf-real-headroom.json';
const FLOOR_MB = 12288;
const RECENT_MS = 20000;
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : NaN);
const validWindow = value => Number.isFinite(value) && value >= 5000 && value <= 60000;
const validShare = value => Number.isFinite(value) && value >= 0.1 && value <= 1;

function memAvailableMb(read = () => fs.readFileSync('/proc/meminfo', 'utf8')) {
  try { const m = /MemAvailable:\s+(\d+) kB/.exec(read()); return m ? Number(m[1]) / 1024 : NaN; } catch { return NaN; }
}

function createSettingsReader({ file = FILE, now = Date.now, read = path => fs.readFileSync(path, 'utf8') } = {}) {
  let checked = -Infinity, value = { enabled: true, floorMb: FLOOR_MB, recentMs: RECENT_MS, pendingShare: 1 };
  return () => {
    const at = now();
    if (at - checked < 1000) return value;
    checked = at;
    let raw = null;
    try { raw = JSON.parse(read(file)); } catch { raw = null; }
    const floor = Number(raw?.floorMb), window = Number(raw?.recentMs), share = Number(raw?.pendingShare);
    value = { enabled: raw?.enabled !== false,
      floorMb: Number.isFinite(floor) && floor >= 4096 && floor <= 65536 ? floor : FLOOR_MB,
      recentMs: validWindow(window) ? window : RECENT_MS,
      pendingShare: validShare(share) ? share : 1 };
    return value;
  };
}

function createRealHeadroomGate(original, { available = memAvailableMb, now = Date.now,
  settings = createSettingsReader(), recentMs = RECENT_MS } = {}) {
  if (typeof original !== 'function') throw new TypeError('original must be a function');
  if (original.__vfRealHeadroomVersion === VERSION) return original;
  if (original.__vfRealHeadroomVersion && typeof original.original === 'function') original = original.original;
  const recent = [];
  let renderWait = null;
  const stats = { version: VERSION, overrides: 0, kept: 0, overrideMb: 0, lastOverrideAt: null,
    lastFreeAfterMb: null, lastReservedMb: null, lastKey: null, renderReserved: 0 };

  const windowMs = current => (validWindow(Number(current?.recentMs)) ? Number(current.recentMs) : recentMs);
  function recentMb(at, ms = recentMs) {
    while (recent.length && (at - recent[0].at >= ms || at < recent[0].at)) recent.shift();
    return recent.reduce((sum, item) => sum + item.mb, 0);
  }

  function decide(request, result) {
    const wait = result && typeof result === 'object' ? result.wait : null;
    if (result === true || result?.allowed !== false || wait?.reasonKey !== 'app_budget') return result;
    const current = settings(), { enabled, floorMb } = current;
    if (!enabled) return result;
    const predicted = num(wait.predictedSlotMb), pending = num(wait.pendingMb) || 0;
    const nativeFree = num(wait.availableMb), realFree = num(available());
    if (!(predicted >= 0) || !Number.isFinite(nativeFree) || !Number.isFinite(realFree)) return result;
    const at = now(), render = request?.lane === 'render';
    const share = validShare(Number(current?.pendingShare)) ? Number(current.pendingShare) : 1;
    const reserved = Math.max(Math.max(0, pending) * share, recentMb(at, windowMs(current)));
    const after = Math.min(nativeFree, realFree) - predicted - reserved;
    stats.lastFreeAfterMb = Math.round(after);
    stats.lastReservedMb = Math.round(reserved);
    const held = !render && renderWait && at - renderWait.at >= 0 && at - renderWait.at < RENDER_HOLD_MS ? renderWait.mb : 0;
    if (after < Math.max(floorMb, num(wait.reserveMb) || 0) + held) {
      stats.kept++;
      if (render) renderWait = { at, mb: predicted };
      else if (held) stats.renderReserved++;
      return result;
    }
    if (render) renderWait = null;
    recent.push({ at, mb: predicted });
    stats.overrides++; stats.overrideMb += Math.round(predicted);
    stats.lastOverrideAt = new Date(at).toISOString(); stats.lastKey = `${request?.lane}/${request?.key}`;
    return { allowed: true };
  }

  function wrapped(...args) {
    const result = Reflect.apply(original, this, args);
    if (result && typeof result.then === 'function') return Promise.resolve(result).then(value => decide(args[0], value));
    return decide(args[0], result);
  }
  wrapped.__vfRealHeadroomVersion = VERSION;
  wrapped.original = original;
  // Inner wrappers (render fairness) keep their own observers reachable.
  for (const name of ['getStats', 'snapshot']) {
    if (typeof original[name] === 'function') wrapped[name] = (...a) => original[name](...a);
  }
  wrapped.headroomStats = () => { const current = settings();
    return { ...stats, recentMb: recentMb(now(), windowMs(current)), settings: current }; };
  return wrapped;
}

module.exports = { createRealHeadroomGate, createSettingsReader, memAvailableMb, VERSION, FLOOR_MB, RECENT_MS };
