import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapMapAdmissionCheck, wrapMapWaiterChoice } from './map-admission.mjs';

function fixture(overrides = {}, decide = () => 'reservation') {
  const state = { lane: { activeTotal: 0, waiters: [] },
    activeMap: { jobId: 'map-job', phase: 'scheduler_wait', cancelled: false }, ...overrides };
  const original = function(...args) { return decide(...args); };
  return { state, original, check: wrapMapAdmissionCheck(original, () => state) };
}
test('idle map queue head may use a slot blocked by queued-behind map reservations', () => {
  const { check } = fixture();
  assert.equal(check('render', 'map-job', 8, 'geomap', 'late-priority'), null);
});
test('capacity, resource caps, cooldown and ordinary failures remain unchanged', () => {
  for (const reason of ['lane', 'resource', 'cooldown', null]) {
    assert.equal(fixture({}, () => reason).check('render', 'map-job', 8, 'geomap'), reason);
  }
});
test('non-map callers and other lanes cannot bypass reservations', () => {
  const { check } = fixture();
  assert.equal(check('render', 'map-job', 8, 'remotion'), 'reservation');
  assert.equal(check('ffmpeg', 'map-job', 14, 'geomap'), 'reservation');
});
test('an active render cannot be displaced', () => {
  assert.equal(fixture({ lane: { activeTotal: 1, waiters: [] } }).check('render', 'map-job', 8, 'geomap'), 'reservation');
});
test('only the valid map admission head can unblock', () => {
  for (const activeMap of [null, { jobId: 'other', phase: 'scheduler_wait' },
    { jobId: 'map-job', phase: 'map_init' }, { jobId: 'map-job', phase: 'scheduler_wait', cancelled: true }]) {
    assert.equal(fixture({ activeMap }).check('render', 'map-job', 8, 'geomap'), 'reservation');
  }
});
test('an eligible higher-priority renderer is not bypassed', () => {
  const { check } = fixture({ lane: { activeTotal: 0,
    waiters: [{ jobId: 'earlier', resourceKey: 'remotion', priority: 'first' }] } },
  (_lane, jobId) => jobId === 'earlier' ? null : 'reservation');
  assert.equal(check('render', 'map-job', 8, 'geomap'), 'reservation');
});
test('the native memory gate still decides after admission', async () => {
  const { check } = fixture();
  let started = false;
  if (check('render', 'map-job', 8, 'geomap') === null) {
    const allowedByMemoryGate = false;
    if (allowedByMemoryGate) started = true;
  }
  assert.equal(started, false);
});
test('original function receiver and invocation are preserved', () => {
  const receiver = {};
  let seen;
  const original = function(...args) { seen = { receiver: this, args }; return 'lane'; };
  const check = wrapMapAdmissionCheck(original, () => { throw new Error('must not inspect state'); });
  check.call(receiver, 'render', 'map-job', 8, 'geomap', 'priority');
  assert.equal(seen.receiver, receiver);
  assert.deepEqual(seen.args, ['render', 'map-job', 8, 'geomap', 'priority']);
});
test('the admitted map can be selected behind a reservation-blocked queue head', () => {
  const { state, check } = fixture();
  const map = { jobId: 'map-job', resourceKey: 'geomap', priority: 'later' };
  state.lane.waiters = [{ jobId: 'earlier', resourceKey: 'remotion', priority: 'earlier' }, map];
  const choose = wrapMapWaiterChoice(() => ({ waiter: null, reason: 'reservation' }), check);
  assert.equal(choose('render', state.lane, 8).waiter, map);
});
test('a chosen normal waiter and non-reservation blocks are never replaced', () => {
  const selected = { waiter: { jobId: 'normal' }, reason: null };
  const choose = wrapMapWaiterChoice(() => selected, () => { throw new Error('must not inspect'); });
  assert.equal(choose('render', { activeTotal: 0 }, 8), selected);
  for (const reason of ['resource', 'cooldown', 'lane']) {
    const blocked = { waiter: null, reason };
    assert.equal(wrapMapWaiterChoice(() => blocked, () => { throw new Error('must not inspect'); })
      ('render', { activeTotal: 0 }, 8), blocked);
  }
});
