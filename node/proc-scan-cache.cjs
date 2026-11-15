'use strict';
// Shared /proc snapshot for the native render memory sampler (W5t).
//
// The sampler runs on every lease finish, every second and 60 ms after every spawn, and
// each run read /proc/<pid>/stat for every process (~170 with 3 motion renders and 30+
// ffmpeg leases) on the main thread: several full scans per second, health 1-8 s.
// The native sampler exposes two hooks for exactly this: a process-table provider (q5t)
// and a PSS reader (SOn). The table is reused for ttlMs.
//
// PSS (2026-11-10): the sampler reads /proc/<pid>/smaps_rollup for every process of a render tree on
// its first sample, whenever the tree's RSS grew 5 % and every 10th sample. The kernel walks all page
// tables for that file, and under load the sampler runs several times per second (every spawn, every
// lease finish), so a growing Chromium tree was re-read on each run: perf on the API main thread
// showed 8.3 % of its CPU time in show_smaps_rollup. A value per pid is now reused for pssTtlMs
// (1 s, the sampler's own base interval). Unreadable processes are never cached.
const fs = require('node:fs');

const PAGE_BYTES = 4096;

function readProcTable(fsImpl = fs) {
  let names;
  try { names = fsImpl.readdirSync('/proc'); } catch { return null; }
  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = fsImpl.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const fields = stat.slice(close + 2).split(' ');
    const ppid = Number(fields[1]), rssPages = Number(fields[21]);
    if (!Number.isFinite(ppid) || !Number.isFinite(rssPages)) continue;
    out.push({ pid: Number(name), ppid, rssBytes: rssPages * PAGE_BYTES });
  }
  return out.length > 0 ? out : null;
}

function readPss(pid, fsImpl = fs) {
  try {
    const match = fsImpl.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)\s+kB/m);
    const kb = Number(match?.[1]);
    return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
  } catch { return null; }
}

const PSS_CACHE_MAX = 2048;

function createProcScan({ ttlMs = 500, pssTtlMs = 1000, now = Date.now, fsImpl = fs } = {}) {
  const stats = { scans: 0, hits: 0 };
  const pssStats = { reads: 0, hits: 0 };
  const pssAt = new Map(); // pid -> [readAtMs, bytes]
  let at = -Infinity, value = null;
  const fresh = (entry, t) => t - entry[0] >= 0 && t - entry[0] < pssTtlMs;
  function pss(pid) {
    const t = now();
    const hit = pssAt.get(pid);
    if (hit && fresh(hit, t)) { pssStats.hits++; return hit[1]; }
    pssStats.reads++;
    const bytes = readPss(pid, fsImpl);
    if (bytes == null) { pssAt.delete(pid); return null; }
    if (pssAt.size >= PSS_CACHE_MAX) {
      for (const [key, entry] of pssAt) if (!fresh(entry, t)) pssAt.delete(key);
      if (pssAt.size >= PSS_CACHE_MAX) pssAt.clear();
    }
    pssAt.set(pid, [t, bytes]);
    return bytes;
  }
  function table() {
    const t = now();
    if (value && t - at >= 0 && t - at < ttlMs) { stats.hits++; return value; }
    stats.scans++;
    value = readProcTable(fsImpl);
    at = t;
    return value;
  }
  return { table, pss, stats, pssStats, pssCacheSize: () => pssAt.size };
}

const shared = createProcScan();
globalThis.__vfProcScan = shared;

module.exports = { createProcScan, readProcTable, readPss, PAGE_BYTES, PSS_CACHE_MAX,
  procScanTable: () => shared.table(), procScanPss: pid => shared.pss(pid), shared };
