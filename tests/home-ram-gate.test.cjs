'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ram = require('../node/home-ram-estimate.cjs');

test('Home dispatches pass while real RAM is above the floor; otherwise and for native keys the gate decides', async () => {
  let available = 18000, gateCalls = 0;
  const gate = async () => { gateCalls++; return { allowed: false, reason: 'live_headroom' }; };
  const wrapped = ram.wrapHomeGate(gate, { available: () => available });
  assert.equal(await wrapped({ key: 'ffmpegHome' }), true);
  assert.equal(gateCalls, 0);
  assert.deepEqual(await wrapped({ key: 'ffmpeg' }), { allowed: false, reason: 'live_headroom' }, 'native keys unchanged');
  available = 4000;
  assert.deepEqual(await wrapped({ key: 'ffmpegHome' }), { allowed: false, reason: 'live_headroom' }, 'below floor: native gate');
  assert.equal(ram.wrapHomeGate(wrapped), wrapped, 'idempotent');
});

test('MemAvailable is parsed from /proc/meminfo', () => {
  assert.equal(ram.memAvailableMb(() => 'MemTotal: 65848000 kB\nMemAvailable:   18284544 kB\n'), 17856);
  assert.equal(ram.memAvailableMb(() => { throw Error('no proc'); }), 0);
});
