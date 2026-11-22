'use strict';
// Render-authorization retry (2026-11-20, owner: "Repariere das problem! Und schau das das nie wieder passiert").
//
// What happened: the app's own render authorization was "temporarily unavailable" for about three minutes
// (20.11. 09:03-09:06Z; the same on 06.11. and 12.11.). The app marks that error as transient ("retry
// shortly"), but a segment that is being dispatched in that window is aborted for the whole run: its promise
// rejects, the segment stays "rendering" in the database with nothing queued, and the video can only recover
// when the complete chunkRender step has ended and the pipeline is retried - hours later for a long video
// (8fe24646 stopped at 1606/1613 segments, 782c9e14 lost 404 segments this way).
//
// What this does: it wraps the segment dispatcher. When a dispatch ends with exactly that transient
// authorization error, the segment waits and is dispatched again, for at most `maxWaitMinutes`. Nothing is
// bypassed: every new attempt goes through the app's normal authorization, and it only succeeds once the app
// grants it again. A denied authorization and every other error pass through unchanged, as do aborted jobs.
// Hot knob: /data/runtime/vf-auth-retry.json  {"enabled": true, "maxWaitMinutes": 45, "minDelaySec": 20, "maxDelaySec": 240}
const fs = require('node:fs');

const VERSION = 1;
const FILE = '/data/runtime/vf-auth-retry.json';
const DEFAULTS = Object.freeze({ enabled: true, maxWaitMinutes: 45, minDelaySec: 20, maxDelaySec: 240 });
const TEXT = /Render authorization is temporarily unavailable/i;
const SLICE_MS = 5000;

function readConfig(file = FILE, readFile = fs.readFileSync) {
  let raw = {};
  try { raw = JSON.parse(readFile(file, 'utf8')) || {}; } catch { raw = {}; }
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const k of ['maxWaitMinutes', 'minDelaySec', 'maxDelaySec']) {
    const v = Number(cfg[k]);
    cfg[k] = Number.isFinite(v) && v > 0 ? v : DEFAULTS[k];
  }
  if (cfg.maxDelaySec < cfg.minDelaySec) cfg.maxDelaySec = cfg.minDelaySec;
  cfg.enabled = cfg.enabled !== false;
  return cfg;
}

// The transient "authorization unavailable" error, looked up along the cause chain; null for everything else.
function authError(error) {
  let cur = error;
  const seen = new Set();
  for (let i = 0; cur && typeof cur === 'object' && i < 8 && !seen.has(cur); i++) {
    seen.add(cur);
    if (cur.retryable === false) return null;
    if (cur.code === 'authorization_unavailable' || cur.name === 'RenderAuthorizationUnavailableError') return cur;
    cur = cur.cause;
  }
  if (error && typeof error === 'object' && error.retryable !== false && TEXT.test(String(error.message || ''))) return error;
  return null;
}

// A dispatch may also come back as a normal "failed" result that only carries the message.
function failedForAuth(result) {
  return !!result && typeof result === 'object' && result.status === 'failed' && TEXT.test(String(result.error || ''));
}

function nextDelayMs(error, attempt, cfg, nowMs) {
  const min = cfg.minDelaySec * 1000, max = cfg.maxDelaySec * 1000;
  let delay = min * Math.pow(2, Math.min(Math.max(attempt, 0), 6));
  const at = Date.parse(String((error && error.retryAt) || ''));
  if (Number.isFinite(at) && at > nowMs) delay = at - nowMs + 5000; // the app says when it asks again
  return Math.max(min, Math.min(max, Math.round(delay)));
}

function defaultSleep(ms) {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); if (t && typeof t.unref === 'function') t.unref(); });
}

function wrapDispatch(original, { sleep = defaultSleep, now = () => Date.now(), read = readConfig, isAborted = () => false,
  log = message => console.log(message), stats = null } = {}) {
  if (typeof original !== 'function') throw new TypeError('dispatch must be a function');
  if (original.__vfAuthRetry) return original;
  const st = stats || { waits: 0, recovered: 0, gaveUp: 0, waiting: 0, lastAt: null, lastJob: null };
  const aborted = args => {
    try { return !!(isAborted(args && args.jobId) || (args && args.deps && args.deps.signal && args.deps.signal.aborted)); } catch { return false; }
  };
  const wrapped = async function dispatchWithAuthRetry(args) {
    let waitedMs = 0, attempt = 0;
    for (;;) {
      let error = null, result;
      try { result = await original.call(this, args); } catch (e) { error = e; }
      let auth = null;
      try { auth = error ? authError(error) : (failedForAuth(result) ? { message: result.error } : null); } catch { auth = null; }
      if (!auth) {
        if (attempt > 0) st.recovered++;
        if (error) throw error;
        return result;
      }
      let cfg;
      try { cfg = read(); } catch { cfg = DEFAULTS; }
      if (!cfg.enabled || waitedMs >= cfg.maxWaitMinutes * 60000 || aborted(args)) {
        if (attempt > 0) st.gaveUp++;
        if (error) throw error;
        return result;
      }
      const delay = nextDelayMs(auth, attempt, cfg, now());
      attempt++;
      st.waits++; st.lastAt = new Date(now()).toISOString(); st.lastJob = args && args.jobId ? String(args.jobId).slice(0, 8) : null;
      if (attempt === 1) {
        try {
          log(`[vf-auth-retry] ${st.lastJob} chunk ${args && args.chunkNumber != null ? args.chunkNumber : '?'} segment ${args && args.segment && args.segment.segment_id != null ? args.segment.segment_id : '?'}: render authorization unavailable, waiting ${Math.round(delay / 1000)} s and dispatching again`);
        } catch { /* logging must never break a render */ }
      }
      st.waiting++;
      try {
        for (let left = delay; left > 0 && !aborted(args); left -= SLICE_MS) await sleep(Math.min(SLICE_MS, left));
      } finally { st.waiting--; }
      waitedMs += delay;
    }
  };
  wrapped.__vfAuthRetry = true;
  wrapped.__vfOriginal = original;
  wrapped.stats = st;
  return wrapped;
}

module.exports = { VERSION, FILE, DEFAULTS, readConfig, authError, failedForAuth, nextDelayMs, wrapDispatch };
