'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '../node/cgroup-pressure.cjs');
const account = fs.existsSync(modulePath) ? require(modulePath).accountCgroupPressure : null;
const MB = 1024 * 1024;
const stat = (extra = {}) => Object.entries({
  anon: 27000 * MB, kernel: 1400 * MB, file: 11200 * MB,
  shmem: 0, file_mapped: 900 * MB, file_dirty: 0, file_writeback: 0,
  inactive_file: 0, active_file: 11200 * MB, ...extra,
}).map(([key, value]) => `${key} ${value}`).join('\n');
function usage(current = 40000 * MB, raw = stat(), native = current) {
  assert.equal(typeof account, 'function', 'pressure accounting implementation required');
  return account(current, raw, native);
}

test('observed MGLRU cache-only latch can clear without changing thresholds', () => {
  const result = usage();
  assert.equal(result, 29700 * MB);
  assert.ok(result < 45014 * MB * 0.8);
});
test('all anonymous Home worker memory is retained, regardless of process group', () => {
  assert.equal(usage(50000 * MB, stat({anon: 39000 * MB})), 40400 * MB);
});
test('shared, mapped, dirty and writeback cache are conservatively retained', () => {
  assert.equal(usage(40000 * MB, stat({shmem: 1000 * MB, file_dirty: 500 * MB,
    file_writeback: 300 * MB})), 31500 * MB);
});
test('native inactive-cache credit never becomes less conservative via missing fields', () => {
  assert.equal(usage(40000 * MB, 'inactive_file 1000\n', 39000 * MB), 39000 * MB);
});
test('no file cache means no discount', () => {
  assert.equal(usage(40000 * MB, stat({file: 0, file_mapped: 0, active_file: 0})), 40000 * MB);
});
test('overlapping protected file categories do not grant a negative discount', () => {
  assert.equal(usage(40000 * MB, stat({file_mapped: 11200 * MB, shmem: 5000 * MB})), 40000 * MB);
});
test('inconsistent overlapping fields grant no extra credit beyond native accounting', () => {
  assert.equal(usage(40000 * MB, stat({file_dirty: 11200 * MB, inactive_file: 11200 * MB}),
    28800 * MB), 28800 * MB);
});
test('native behavior is retained when clean-file estimate gives no extra credit', () => {
  assert.equal(usage(40000 * MB, stat({inactive_file: 11000 * MB}), 29000 * MB), 29000 * MB);
});
for (const bad of [stat().replace('file 11744051200', 'file NaN'),
  stat().replace('anon 28311552000', 'anon -1'), stat() + '\nfile 1', '', null]) {
  test(`invalid or ambiguous statistics fail closed: ${String(bad).slice(0, 28)}`, () => {
    assert.equal(usage(40000 * MB, bad, 39000 * MB), 39000 * MB);
  });
}
test('inconsistent cgroup sample fails closed', () => {
  assert.equal(usage(100 * MB), 100 * MB);
});
test('all numbers stay bounded and finite', () => {
  assert.equal(usage(NaN, stat(), 123), 123);
  assert.equal(usage(-1, stat(), 123), 123);
});
test('native pressure still blocks real anonymous memory pressure', () => {
  const result = usage(54000 * MB, stat({anon: 41000 * MB}));
  assert.ok(result > 45014 * MB * 0.9);
});
