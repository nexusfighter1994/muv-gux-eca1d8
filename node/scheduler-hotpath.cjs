'use strict';
// Main-thread hot paths of the native render scheduler (2026-10-16 profile).
// Pure: callers pass native functions/maps; results equal the native/inline
// versions, only repeated identical work inside ONE synchronous call is skipped.

const RENDER_KINDS = new Set(['frameshift', 'remotion']);

// Native frameshift limit getter reads the SQLite 'general' row on every call.
function createLimitCache(original, { ttlMs = 1000, now = Date.now, stats = { hits: 0, misses: 0 } } = {}) {
  if (typeof original !== 'function') throw new TypeError('original must be a function');
  let cached = null;
  function limit() {
    const at = now();
    if (cached !== null && at >= cached.at && at - cached.at < ttlMs) { stats.hits++; return cached.value; }
    const value = Reflect.apply(original, this, arguments);
    cached = { at, value };
    stats.misses++;
    return value;
  }
  function wrapWriter(writer) {
    if (typeof writer !== 'function') throw new TypeError('writer must be a function');
    return function invalidating() {
      cached = null;
      try { return Reflect.apply(writer, this, arguments); } finally { cached = null; }
    };
  }
  return { limit, wrapWriter, invalidate: () => { cached = null; }, stats };
}

// Same contract as the inline finish-first getState: {render, waitingSinceMs,
// hasReadyRender, focus, requestPriority}. While a render is active the native
// fairness observer returns 'render_active' before reading readiness, so the
// waiter scan is skipped there; otherwise each distinct admission key is checked once.
function createFocusState({ pX, XBe, KBe, jp }) {
  for (const [name, fn] of Object.entries({ pX, XBe, KBe })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a function');
  }
  if (!(jp instanceof Map)) throw new TypeError('jp must be a Map');
  return function getState(request) {
    const s = pX('render');
    let focus = null;
    for (const [jobId, job] of jp) {
      if (typeof job.priority !== 'string') throw Error('Invalid native priority');
      if (!focus || job.priority < focus.priority) focus = { jobId, priority: job.priority };
    }
    let ready = false, focusReady = false;
    if (!(Number.isSafeInteger(s?.activeTotal) && s.activeTotal > 0)) {
      const limit = KBe('render'), memo = new Map();
      for (const w of s.waiters) {
        if (!RENDER_KINDS.has(w.resourceKey)) continue;
        const key = w.jobId + '\0' + w.resourceKey + '\0' + w.priority;
        let ok = memo.get(key);
        if (ok === undefined) {
          ok = XBe('render', w.jobId, limit, w.resourceKey, w.priority) === null;
          memo.set(key, ok);
        }
        if (!ok) continue;
        ready = true;
        if (focus && w.jobId === focus.jobId && w.priority === focus.priority) { focusReady = true; break; }
      }
    }
    return { render: s, waitingSinceMs: Date.parse(s.memoryWait?.waitingSinceIso), hasReadyRender: ready,
      focus: focus && { ...focus, hasReadyRender: focusReady }, requestPriority: jp.get(request?.jobId)?.priority };
  };
}

module.exports = { createLimitCache, createFocusState };
