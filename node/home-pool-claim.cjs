'use strict';
// Home queue admission for FFlow-routed Home work (compositions, video trims). Claims may run
// ahead of the pool's ready workers: a claimed job is still prepared on the server before FFlow
// queues it, and the pool only grows from busy workers (pc_home_pool.py), so admitting exactly
// readyWorkers kept ready workers idle and the pool small while hundreds of jobs waited.
// Limit = min(Home capacity, max(2 x ready, ready + 4)); 0 while the pool is not ready.
const fs = require('node:fs');
const POOL_PATH = '/data/runtime/pc-home-pool.json';

function claimLimit(requested, ready) {
  if (!(Number(ready) > 0) || !(Number(requested) > 0)) return 0;
  return Math.min(requested, Math.max(ready * 2, ready + 4));
}

// The pool file as the pool manager writes it every second; read at most once per second.
function createPoolReader({ path = POOL_PATH, now = Date.now, read = p => JSON.parse(fs.readFileSync(p, 'utf8')) } = {}) {
  let cached = { at: -Infinity, value: null };
  return () => {
    const t = now();
    if (t - cached.at >= 1000) {
      let value = null;
      try { value = read(path); } catch { value = null; }
      cached = { at: t, value };
    }
    return cached.value;
  };
}

function readyWorkers(pool, now = Date.now()) {
  return pool?.mode === 'home-only' && pool.ready && now - pool.checkedAt < 45000 ? Math.max(0, Number(pool.readyWorkers) || 0) : 0;
}

function makeCanClaim({ getCapacity, readPool = createPoolReader(), now = Date.now }) {
  return (w, scopes) => {
    if (w.homeKind === 'video-normalize') return true;
    const limit = claimLimit(Number(getCapacity()) || 0, readyWorkers(readPool(), now()));
    let flow = 0;
    for (const s of scopes) if (s.kind !== 'video-normalize') flow++;
    return flow < limit;
  };
}

module.exports = { claimLimit, createPoolReader, readyWorkers, makeCanClaim };
