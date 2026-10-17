'use strict';

const { isPromise } = require('node:util/types');
const NATIVE_KEYS = new Set(['ffmpeg', 'fflowComposition']);
const MEMORY_REASONS = new Set(['live_headroom', 'app_budget']);
const SAFE_MB_FIELDS = ['pendingMb', 'availableMb', 'reserveMb', 'budgetMb',
  'baselineMb', 'activeEstimatedMb'];
const MAX_DATE_MS = 8.64e15;
const positive = value => Number.isFinite(value) && value > 0;
const timestamp = value => Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS;

function createRenderMemoryFairness(original, {
  getState, now = Date.now, waitMs = 60000, drainMs = 45000, cooldownMs = 60000
} = {}) {
  if (typeof original !== 'function') throw new TypeError('original must be a function');
  const enabled = typeof getState === 'function' && typeof now === 'function'
    && [waitMs, drainMs, cooldownMs].every(positive);
  waitMs = Math.max(60000, waitMs);
  drainMs = Math.min(45000, drainMs);
  cooldownMs = Math.max(60000, cooldownMs);
  const stats = { status: 'idle', reason: 'not_observed', drainWindows: 0,
    delayedRequests: 0, nativeCalls: 0, renderGrants: 0, pendingRenderChecks: 0,
    stateErrors: 0 };
  let drain = null, cooldownUntilMs = null, lastTime = null;

  function close(at, reason) {
    drain = null;
    cooldownUntilMs = at + cooldownMs;
    stats.status = 'cooldown';
    stats.reason = reason;
  }

  function fault(reason, at = lastTime) {
    stats.stateErrors++;
    if (drain) close(at, reason);
    if (stats.status !== 'cooldown') {
      stats.status = 'idle';
      stats.reason = reason;
    }
    return null;
  }

  function readTime() {
    const at = now();
    if (!timestamp(at) || !timestamp(at + drainMs + cooldownMs)) {
      throw new RangeError('invalid clock');
    }
    return at;
  }

  function observe(request) {
    if (!enabled) {
      stats.reason = 'invalid_config';
      return null;
    }
    let at;
    try { at = readTime(); } catch { return fault('invalid_time'); }
    if (lastTime !== null && at < lastTime) {
      lastTime = at;
      return fault('invalid_time', at);
    }
    lastTime = at;
    // Use the fixed deadline, not observation time, so an idle gap adds no cooldown.
    if (drain && at >= drain.until) close(drain.until, 'drain_expired');
    if (cooldownUntilMs !== null && at >= cooldownUntilMs) {
      cooldownUntilMs = null;
      stats.status = 'idle';
    }
    let sample, reason;
    try {
      const source = getState(request), render = source?.render;
      const active = render?.activeTotal, waiters = render?.waiters;
      const ready = source?.hasReadyRender;
      if (!Number.isSafeInteger(active) || active < 0 || !Array.isArray(waiters)
        || typeof ready !== 'boolean') return fault('invalid_state', at);
      const wait = render.memoryWait, reasonKey = wait?.reasonKey;
      const since = source.waitingSinceMs;
      const focused = Object.hasOwn(source, 'focus'), focus = focused ? source.focus : null;
      if (focused && focus !== null && (!focus || typeof focus.jobId !== 'string'
        || !focus.jobId || typeof focus.priority !== 'string'
        || typeof focus.hasReadyRender !== 'boolean')) return fault('invalid_focus', at);
      if (active > 0) reason = 'render_active';
      else if (!ready) reason = 'no_ready_render';
      else if (waiters.length === 0) reason = 'no_render_waiters';
      else if (focused && !focus) reason = 'no_focus';
      else if (focused && (!focus.hasReadyRender || !waiters.some(w => w?.jobId === focus.jobId
        && w.priority === focus.priority && ['remotion', 'frameshift'].includes(w.resourceKey)))) {
        reason = 'focus_not_ready';
      }
      else if (drain && (drain.focusJobId !== focus?.jobId
        || drain.focusPriority !== focus?.priority)) reason = 'focus_changed';
      else if (!MEMORY_REASONS.has(reasonKey)) reason = 'memory_reason_changed';
      else if (!timestamp(since) || since > at) return fault('invalid_state', at);
      else if (drain && reasonKey !== drain.reasonKey) reason = 'memory_reason_changed';
      else if (drain && since !== drain.since) reason = 'waiting_since_changed';
      else if (at - since < waitMs) reason = 'wait_threshold';
      if (!reason) {
        const safe = {};
        for (const key of SAFE_MB_FIELDS) {
          const value = wait[key];
          if (Number.isFinite(value) && value >= 0) safe[key] = value;
        }
        const predicted = wait.predictedSlotMb, resource = wait.resourceKey;
        if (Number.isFinite(predicted) && predicted >= 0) safe.renderPredictedSlotMb = predicted;
        if (typeof resource === 'string' && resource.length <= 128) safe.renderResourceKey = resource;
        sample = { at, since, reasonKey, safe, focusJobId: focus?.jobId,
          focusPriority: focus?.priority, requestPriority: source.requestPriority };
      }
    } catch { return fault('invalid_state', at); }
    if (drain && reason) close(at, reason);
    if (!drain && cooldownUntilMs === null) {
      stats.status = sample ? 'pending' : 'idle';
      stats.reason = sample ? 'render_waiting' : reason;
    }
    return sample;
  }

  function noteGrant(result) {
    try {
      if (result !== true && result?.allowed !== true) return;
      stats.renderGrants++;
      let at = lastTime;
      try { at = Math.max(at ?? 0, readTime()); } catch { /* Keep the last valid observation. */ }
      if (at !== null && enabled) close(at, 'render_granted');
    } catch { /* Observing a native result must not change its behavior. */ }
  }

  function observeRenderResult(result) {
    if (!isPromise(result)) {
      noteGrant(result);
      return;
    }
    stats.pendingRenderChecks++;
    // Observe native promises without replacing them or consuming arbitrary thenables.
    try {
      Promise.prototype.then.call(result, value => {
        stats.pendingRenderChecks--;
        noteGrant(value);
      }, () => { stats.pendingRenderChecks--; });
    } catch { stats.pendingRenderChecks--; }
  }

  function wrapped(...args) {
    const sample = observe(args[0]);
    let lane, key, jobId;
    try { lane = args[0]?.lane; key = args[0]?.key; jobId = args[0]?.jobId; }
    catch { key = null; /* Delegate unchanged. */ }
    // Legacy observers retain lane-wide fairness; production supplies native focus metadata.
    const lowerPriority = sample && (sample.focusJobId === undefined
      || typeof jobId === 'string' && jobId !== sample.focusJobId
      && typeof sample.requestPriority === 'string' && sample.requestPriority > sample.focusPriority);
    if (lowerPriority && lane === 'ffmpeg' && NATIVE_KEYS.has(key) && cooldownUntilMs === null) {
      if (!drain) {
        drain = { since: sample.since, reasonKey: sample.reasonKey,
          focusJobId: sample.focusJobId, focusPriority: sample.focusPriority,
          started: sample.at, until: sample.at + drainMs };
        stats.drainWindows++;
      }
      stats.status = 'draining';
      stats.reason = 'render_fair_turn';
      stats.delayedRequests++;
      return { allowed: false, wait: { ...sample.safe, reasonKey: 'render_fair_turn',
        laneKey: 'ffmpeg', resourceKey: key, renderReasonKey: sample.reasonKey,
        waitingSinceIso: new Date(sample.since).toISOString(),
        nextRetryAtIso: new Date(Math.min(sample.at + 5000, drain.until)).toISOString(),
        drainUntilIso: new Date(drain.until).toISOString() } };
    }
    stats.nativeCalls++;
    const result = Reflect.apply(original, this, args);
    if (lane === 'render') observeRenderResult(result);
    return result;
  }

  wrapped.getStats = function getStats() {
    observe();
    return { ...stats, drainStartedAtMs: drain?.started ?? null,
      drainUntilMs: drain?.until ?? null, cooldownUntilMs };
  };
  wrapped.snapshot = function snapshot() {
    const stats = wrapped.getStats();
    return { pending: stats.status === 'pending', effective: stats.status === 'draining', stats };
  };
  return wrapped;
}

module.exports = { createRenderMemoryFairness };
