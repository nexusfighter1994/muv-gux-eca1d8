'use strict';
// Long-video cap (2026-11-18, owner: "Sollten wir nun bei den langen videos auf 5 reduzieren die zugleich
// rendern?" -> "Mach das bitte"). At most `maxLong` long videos (custom script >= `longWords` words) run at the
// same time; short videos keep using the remaining maxActiveVideos slots.
// Mechanism: the stock queue start statement only starts a job when available_at IS NULL or reached, and the
// dispatcher skips such a job and tries the next one. While the cap is reached, queued long videos get an
// available_at a few minutes ahead (milliseconds .987 mark our own holds; other schedules are never touched).
// Below the cap, exactly as many long videos as there are free long slots are released in queue order and the
// dispatcher is woken. Running videos are never touched. Hot knob: /data/runtime/vf-long-video-cap.json.
//
// 2026-11-20 (owner: "Repariere das problem! Und schau das das nie wieder passiert"): a long video that was
// already running and came back to the queue (auto-retry after a failed step, resume) keeps its saved work
// in `chunks`. The cap parked such videos like fresh ones: 0d420955 sat 8+ h behind the cap after a TTS
// retry, and a video one step from the end would have joined it. Queued long videos WITH saved work are
// now never held (`resumeExempt`); they take one of the long slots, so fewer fresh long videos are released.
// The retry also left 8fe24646 (1606 of 1613 segments done) at place 20 of 68, behind fresh videos, while its
// slot went to one of them. Queued videos with saved work, long or short, are therefore moved in front of
// the fresh ones (`resumeFront`), keeping their own order; scheduled videos are left alone.
const fs = require('node:fs');

const FILE = '/data/runtime/vf-long-video-cap.json';
const DEFAULTS = Object.freeze({ enabled: true, maxLong: 5, longWords: 8000, holdMinutes: 10, tickSec: 30, resumeExempt: true, resumeFront: true });
const MARK_MS = 987;

function readConfig(file = FILE, readFile = fs.readFileSync) {
  let raw = {};
  try { raw = JSON.parse(readFile(file, 'utf8')) || {}; } catch { raw = {}; }
  const cfg = { ...DEFAULTS, ...raw };
  for (const k of ['maxLong', 'longWords', 'holdMinutes', 'tickSec']) {
    const v = Number(cfg[k]);
    cfg[k] = Number.isFinite(v) && v > 0 ? v : DEFAULTS[k];
  }
  cfg.enabled = cfg.enabled !== false;
  cfg.resumeExempt = cfg.resumeExempt !== false;
  cfg.resumeFront = cfg.resumeFront !== false;
  return cfg;
}

function scriptWords(payloadJson) {
  try {
    const p = JSON.parse(payloadJson || '{}');
    const s = typeof p.customScript === 'string' ? p.customScript : '';
    return s ? s.split(/\s+/).filter(Boolean).length : 0;
  } catch { return 0; }
}

function holdStamp(nowMs, minutes) {
  const d = new Date(nowMs + minutes * 60000);
  d.setUTCMilliseconds(MARK_MS);
  return d.toISOString();
}

const isOurHold = v => typeof v === 'string' && v.endsWith(`.${MARK_MS}Z`);

function createLongVideoCap({ db, dispatch = () => {}, now = () => Date.now(), read = readConfig, log = m => console.log(`[vf-long-cap] ${m}`) }) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db must be a better-sqlite3 handle');
  const words = new Map();
  const stats = { ticks: 0, longRunning: 0, held: 0, released: 0, refreshed: 0, resuming: 0, movedFront: 0, lastError: null, lastAt: null };
  const wordsOf = id => {
    if (!words.has(id)) {
      const row = db.prepare('SELECT payload_json FROM queue_jobs WHERE id = ?').get(id);
      words.set(id, scriptWords(row && row.payload_json));
    }
    return words.get(id);
  };
  // Queued videos that already have saved work. A failing lookup means "none": the cap then behaves as before.
  const savedWork = () => {
    try {
      const rows = db.prepare("SELECT DISTINCT job_id FROM chunks WHERE job_id IN (SELECT id FROM queue_jobs WHERE status = 'queued')").all();
      return new Set(rows.map(r => r && r.job_id).filter(Boolean));
    } catch { return new Set(); }
  };
  function tick() {
    const cfg = read();
    stats.ticks++; stats.lastAt = new Date(now()).toISOString();
    try {
      const running = db.prepare("SELECT id FROM queue_jobs WHERE status IN ('running', 'pausing')").all();
      const longRunning = running.filter(r => wordsOf(r.id) >= cfg.longWords).length;
      stats.longRunning = longRunning;
      const queued = db.prepare("SELECT id, available_at, queued_at FROM queue_jobs WHERE status = 'queued' ORDER BY queued_at ASC, created_at ASC, id ASC").all();
      const saved = cfg.enabled && (cfg.resumeExempt || cfg.resumeFront) ? savedWork() : new Set();
      const resumable = cfg.resumeExempt ? saved : new Set();
      const isResume = q => resumable.has(q.id) && wordsOf(q.id) >= cfg.longWords && (q.available_at === null || isOurHold(q.available_at));
      const resuming = queued.filter(isResume).length;
      stats.resuming = resuming;
      let free = cfg.enabled ? Math.max(0, cfg.maxLong - longRunning - resuming) : Infinity;
      const nowMs = now();
      let held = 0, released = 0;
      const startable = new Set(queued.filter(q => q.available_at === null).map(q => q.id));
      for (const q of queued) {
        if (wordsOf(q.id) < cfg.longWords) continue;
        const ours = isOurHold(q.available_at);
        if (!ours && q.available_at !== null) continue; // someone else's schedule
        if (isResume(q)) { // was already running: never park it behind the cap
          if (ours) {
            db.prepare("UPDATE queue_jobs SET available_at = NULL WHERE id = ? AND status = 'queued' AND available_at = ?").run(q.id, q.available_at);
            released++;
          }
          startable.add(q.id);
          continue;
        }
        if (free > 0) {
          free--;
          if (ours) {
            db.prepare("UPDATE queue_jobs SET available_at = NULL WHERE id = ? AND status = 'queued' AND available_at = ?").run(q.id, q.available_at);
            released++;
          }
          continue;
        }
        held++;
        startable.delete(q.id);
        const expires = ours ? Date.parse(q.available_at) : 0;
        if (!ours || expires - nowMs < (cfg.holdMinutes * 60000) / 2) {
          db.prepare("UPDATE queue_jobs SET available_at = ? WHERE id = ? AND status = 'queued' AND (available_at IS NULL OR available_at = ?)")
            .run(holdStamp(nowMs, cfg.holdMinutes), q.id, q.available_at);
          stats.refreshed++;
        }
      }
      // Videos with saved work go in front of the fresh ones, in their own order.
      let moved = 0;
      if (cfg.enabled && cfg.resumeFront && saved.size) {
        const back = queued.filter(q => saved.has(q.id) && startable.has(q.id));
        const firstFresh = queued.findIndex(q => !saved.has(q.id));
        const base = queued.length ? Date.parse(queued[0].queued_at) : NaN;
        if (back.length && firstFresh >= 0 && Number.isFinite(base) && back.some(q => queued.indexOf(q) > firstFresh)) {
          const stampNow = new Date(nowMs).toISOString();
          back.forEach((q, k) => {
            moved += db.prepare("UPDATE queue_jobs SET queued_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
              .run(new Date(base - (back.length - k) * 1000).toISOString(), stampNow, q.id).changes || 0;
          });
        }
      }
      for (const id of [...words.keys()]) if (!running.some(r => r.id === id) && !queued.some(q => q.id === id)) words.delete(id);
      stats.held = held; stats.released += released; stats.movedFront += moved;
      if (moved) log(`moved ${moved} video(s) with saved work to the queue front`);
      if (released || moved) {
        if (released) log(`released ${released} long video(s): long running ${longRunning}/${cfg.maxLong}`);
        try { Promise.resolve(dispatch()).catch(() => {}); } catch {}
      }
      stats.lastError = null;
    } catch (e) { stats.lastError = String(e && e.message || e); }
    return { ...stats };
  }
  let timer = null;
  return {
    tick, stats,
    start() {
      if (timer) return;
      const loop = () => { tick(); timer = setTimeout(loop, read().tickSec * 1000); timer.unref?.(); };
      timer = setTimeout(loop, 1000); timer.unref?.();
    },
    stop() { if (timer) clearTimeout(timer); timer = null; },
  };
}

module.exports = { DEFAULTS, FILE, MARK_MS, readConfig, scriptWords, holdStamp, isOurHold, createLongVideoCap };
