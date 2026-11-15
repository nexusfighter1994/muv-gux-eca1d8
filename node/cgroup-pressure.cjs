'use strict';

const REQUIRED = ['anon', 'kernel', 'file', 'shmem', 'file_mapped', 'file_dirty',
  'file_writeback', 'inactive_file', 'active_file'];
const valid = value => Number.isSafeInteger(value) && value >= 0;

function accountCgroupPressure(current, raw, nativeBytes) {
  if (!valid(current) || !valid(nativeBytes) || typeof raw !== 'string') return nativeBytes;
  const stats = Object.create(null);
  for (const line of raw.trim().split('\n')) {
    const [key, value, extra] = line.trim().split(/\s+/);
    if (!REQUIRED.includes(key)) continue;
    if (extra || Object.hasOwn(stats, key) || !/^\d+$/.test(value || '')) return nativeBytes;
    stats[key] = Number(value);
  }
  if (REQUIRED.some(key => !valid(stats[key]))) return nativeBytes;
  const floor = stats.anon + stats.kernel;
  if (!valid(floor) || floor > current || stats.file > current) return nativeBytes;

  // Protect shared/mapped pages and pending writes even where categories overlap.
  // cgroup counters include detached Home workers omitted by process-manager RSS.
  const protectedFile = stats.shmem + stats.file_mapped + stats.file_dirty + stats.file_writeback;
  if (!valid(protectedFile)) return nativeBytes;
  const cleanUnmapped = Math.max(0, stats.file - protectedFile);
  return Math.min(nativeBytes, Math.max(floor, current - cleanUnmapped));
}

module.exports = {accountCgroupPressure};
