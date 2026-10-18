'use strict';
// Finish-first job priority: the further a running video is, the earlier the
// native scheduler serves it. Rank = pipeline phase (assembly > composing chunks
// > rendering segments > planning > preparation; with earlyPhasePriority planning and
// preparation come first), then progress inside the phase
// in 5% buckets (stable, no flapping), then original start time. Uses the native
// progress function (same numbers the UI shows) and rewrites ONLY registered
// job priorities plus their own non-interactive waiters; interactive "" stays first.

const TIERS = { completed: 0, assembly: 0, 'chunk-composition': 1, segments: 2, planning: 3, preparation: 4 };
// /custom "Prioritize jobs until segment rendering" (scheduling-settings.cjs earlyPhasePriority):
// the short steps before segment rendering hold a whole video, so those jobs go first
// (planning before preparation); from segment rendering on the order is finish-first again.
const EARLY_TIERS = { planning: 0, preparation: 1, completed: 2, assembly: 2, 'chunk-composition': 3, segments: 4 };
const UNKNOWN_TIER = 5;
const { schedulingSettings } = require('./scheduling-settings.cjs');
const BUCKETS = 20;

function phaseFraction(d) {
  const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? Math.max(0, Math.min(1, a / b)) : 0);
  switch (d?.basis) {
    case 'chunk-composition': return ratio(d.completedChunks, d.totalChunks);
    case 'segments': return ratio(d.completedSegments, d.totalSegments);
    case 'planning': return ratio(d.plannedChunks, d.totalChunks);
    case 'preparation': return ratio(d.progress, 0.175);
    default: return 1;
  }
}

function rankKey(jobId, detail, row, { early = false } = {}) {
  const tier = (early ? EARLY_TIERS : TIERS)[detail?.basis] ?? UNKNOWN_TIER;
  const bucket = Math.max(0, Math.min(BUCKETS, Math.floor(phaseFraction(detail) * BUCKETS + 1e-9)));
  const stamp = v => (typeof v === 'string' && v ? v : '~');
  return `${tier}|${String(BUCKETS - bucket).padStart(2, '0')}|${stamp(row?.started_at)}|${stamp(row?.queued_at)}|${jobId}`;
}

function createJobPriority({ getJobs, getLanes, progress, getDb, wake = () => {}, intervalMs = 5000,
  setTimer = setInterval, clearTimer = clearInterval, settings = schedulingSettings }) {
  for (const [name, fn] of Object.entries({ getJobs, getLanes, progress, getDb, wake })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a function');
  }
  const stats = { ticks: 0, changes: 0, waitersUpdated: 0, errors: 0, lastError: null, at: null, top: [] };
  let statement = null, statementDb = null, timer = null;

  function times(jobId) {
    const db = getDb();
    if (!db || typeof db.prepare !== 'function') return null;
    if (statementDb !== db) { statement = db.prepare('SELECT started_at, queued_at FROM queue_jobs WHERE id = ?'); statementDb = db; }
    return statement.get(jobId) || null;
  }

  function keyFor(jobId, early = settings().earlyPhasePriority === true) {
    let detail = null, row = null;
    try { detail = progress(jobId); } catch { detail = null; }
    try { row = times(jobId); } catch { row = null; }
    return rankKey(jobId, detail, row, { early });
  }

  function tick() {
    try {
      const jobs = getJobs(), lanes = getLanes();
      if (!(jobs instanceof Map) || !(lanes instanceof Map)) return 0;
      const updates = new Map(), early = settings().earlyPhasePriority === true;
      stats.early = early;
      for (const [jobId, job] of jobs) {
        if (!job || typeof job.priority !== 'string' || job.priority === '') continue;
        const key = keyFor(jobId, early);
        if (key !== job.priority) updates.set(jobId, { old: job.priority, key });
      }
      stats.ticks++;
      stats.at = new Date().toISOString();
      stats.top = [...jobs].map(([id, j]) => [updates.get(id)?.key ?? j.priority, id]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .slice(0, 3).map(([priority, jobId]) => ({ jobId, priority }));
      if (!updates.size) return 0;
      for (const [jobId, { key }] of updates) jobs.get(jobId).priority = key;
      for (const lane of lanes.values()) {
        for (const w of lane?.waiters ?? []) {
          const u = updates.get(w?.jobId);
          if (u && w.priority === u.old) { w.priority = u.key; stats.waitersUpdated++; }
        }
      }
      stats.changes += updates.size;
      try { const pumped = wake(); if (pumped && typeof pumped.catch === 'function') pumped.catch(() => {}); }
      catch { /* Pumps also run on the next scheduler event. */ }
      return updates.size;
    } catch (error) {
      stats.errors++;
      stats.lastError = String(error?.message || error).slice(0, 200);
      return 0;
    }
  }

  function start() {
    if (timer) return false;
    timer = setTimer(tick, intervalMs);
    timer?.unref?.();
    return true;
  }
  function stop() { if (timer) clearTimer(timer); timer = null; }
  return { tick, start, stop, keyFor, stats };
}

module.exports = { createJobPriority, rankKey, phaseFraction, TIERS, EARLY_TIERS };
