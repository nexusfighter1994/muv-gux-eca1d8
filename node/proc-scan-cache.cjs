'use strict';
// Shared /proc snapshot for the native render memory sampler (W5t).
//
// The sampler runs on every lease finish, every second and 60 ms after every spawn, and
// each run read /proc/<pid>/stat for every process (~170 with 3 motion renders and 30+
// ffmpeg leases) on the main thread: several full scans per second, health 1-8 s.
// The native sampler exposes two hooks for exactly this: a process-table provider (q5t)
// and a PSS reader (SOn). The table is reused for ttlMs; PSS is read like native.
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

function createProcScan({ ttlMs = 500, now = Date.now, fsImpl = fs } = {}) {
  const stats = { scans: 0, hits: 0 };
  let at = -Infinity, value = null;
  function table() {
    const t = now();
    if (value && t - at >= 0 && t - at < ttlMs) { stats.hits++; return value; }
    stats.scans++;
    value = readProcTable(fsImpl);
    at = t;
    return value;
  }
  return { table, pss: pid => readPss(pid, fsImpl), stats };
}

const shared = createProcScan();
globalThis.__vfProcScan = shared;

module.exports = { createProcScan, readProcTable, readPss, PAGE_BYTES,
  procScanTable: () => shared.table(), procScanPss: pid => shared.pss(pid), shared };
