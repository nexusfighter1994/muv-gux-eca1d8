import assert from 'node:assert/strict';
import test from 'node:test';

// Explicit pre-fix boundary: the native check and chooser are left unchanged.
const { wrapRenderAdmissionCheck, wrapRenderWaiterChoice } = process.argv.includes('--baseline')
  ? { wrapRenderAdmissionCheck: fn => fn, wrapRenderWaiterChoice: fn => fn }
  : await import('../node/render-admission.mjs');

const waiter = (jobId, priority = '020', resourceKey = 'remotion') =>
  ({ jobId, priority, resourceKey });

function fixture({ waiters = [waiter('ready')], activeTotal = 2, cap = 5 } = {}) {
  const lane = { activeTotal, activeByResource: new Map([['frameshift', 2]]), waiters };
  const calls = [];
  const denied = new Map();
  const resources = new Map([['frameshift', 2], ['remotion', 5]]);
  const owner = { native: true };
  function original(...args) {
    assert.equal(this, owner);
    calls.push(args);
    const [, jobId, limit, resource] = args;
    if (denied.has(jobId)) return denied.get(jobId);
    if (lane.activeTotal >= limit) return 'lane';
    if ((lane.activeByResource.get(resource) || 0) >= (resources.get(resource) ?? Infinity)) {
      return 'resource';
    }
    return 'reservation';
  }
  const getState = (jobId, priority) => ({ lane,
    priority: priority ?? lane.waiters.find(w => w.jobId === jobId)?.priority });
  const check = wrapRenderAdmissionCheck(original, getState);
  return { lane, cap, calls, denied, resources, owner, original, getState, check,
    admit: (w = waiters[0], limit = cap) =>
      check.call(owner, 'render', w.jobId, limit, w.resourceKey, w.priority) };
}

test('idle slots: active 2/5, Frameshift 2/2, 486 ready waiters, future-only reservation', () => {
  const waiters = [waiter('blocked', '010', 'frameshift'),
    ...Array.from({ length: 485 }, (_, i) => waiter(`ready-${i}`, '020'))];
  const f = fixture({ waiters });
  assert.equal(f.original.call(f.owner, 'render', 'ready-0', 5, 'remotion', '020'), 'reservation');
  assert.equal(f.admit(waiters[1]), null, 'three counted render slots must not sit unused');
  assert.equal(f.lane.activeTotal, 2);
  assert.equal(f.lane.activeByResource.get('frameshift'), 2);
});

test('borrows only three counted slots and stops at native lane cap', () => {
  const f = fixture();
  let admitted = 0;
  while (admitted < 10 && f.admit() === null) {
    admitted++;
    f.lane.activeTotal++;
    f.lane.activeByResource.set('remotion', admitted);
  }
  assert.equal(admitted, 3);
  assert.equal(f.lane.activeTotal, 5);
  assert.equal(f.admit(), 'lane');
});

for (const reason of [null, 'reservation']) {
  test(`earlier ready higher-priority waiter blocks borrowing when native reason is ${reason}`, () => {
    const earlier = waiter('earlier', '010');
    const later = waiter('later', '020');
    const f = fixture({ waiters: [earlier, later] });
    f.denied.set('earlier', reason);
    assert.equal(f.admit(later), 'reservation');
  });
}

for (const reason of ['resource', 'memory', 'cooldown', 'license', 'cancel', 'lane']) {
  test(`higher-priority waiter blocked by ${reason} does not strand eligible ready work`, () => {
    const earlier = waiter('earlier', '010', 'frameshift');
    const later = waiter('later');
    const f = fixture({ waiters: [earlier, later] });
    f.denied.set('earlier', reason);
    assert.equal(f.admit(later), null);
  });
}

test('Frameshift can borrow below, but never above, its native resource cap', () => {
  const f = fixture({ waiters: [waiter('ready', '020', 'frameshift')] });
  assert.equal(f.admit(), 'resource');
  f.lane.activeByResource.set('frameshift', 1);
  assert.equal(f.admit(), null);
  f.lane.activeByResource.set('frameshift', 2);
  assert.equal(f.admit(), 'resource');
});

for (const reason of ['memory', 'cooldown', 'license', 'cancel', 'resource', 'lane', null, 'unknown']) {
  test(`preserves native ${reason} result without reading state`, () => {
    let reads = 0;
    const check = wrapRenderAdmissionCheck(() => reason, () => { reads++; throw Error('state read'); });
    assert.equal(check('render', 'ready', 5, 'remotion', '020'), reason);
    assert.equal(reads, 0);
  });
}

test('no ready work means no reservation lending', () => {
  const f = fixture({ waiters: [] });
  assert.equal(f.admit(waiter('future')), 'reservation');
});

for (const cap of [Infinity, NaN, undefined, '5', 2, 1, 0, -1]) {
  test(`refuses non-finite/non-numeric/full lane cap ${cap}`, () => {
    const f = fixture();
    const check = wrapRenderAdmissionCheck(() => 'reservation', f.getState);
    assert.equal(check('render', 'ready', cap, 'remotion', '020'), 'reservation');
  });
}

for (const lane of [undefined, null, {}, { activeTotal: NaN, waiters: [] },
  { activeTotal: -1, waiters: [waiter('ready')] },
  { activeTotal: '2', waiters: [waiter('ready')] }]) {
  test(`malformed lane state fails closed: ${JSON.stringify(lane)}`, () => {
    const check = wrapRenderAdmissionCheck(() => 'reservation', () => ({ lane, priority: '020' }));
    assert.equal(check('render', 'ready', 5, 'remotion', '020'), 'reservation');
  });
}

test('requires exact registered job, resource and effective priority', () => {
  const f = fixture();
  f.lane.activeByResource.set('frameshift', 1);
  for (const [id, resource, priority] of [['missing', 'remotion', '020'],
    ['ready', 'frameshift', '020'], ['ready', 'remotion', '999']]) {
    assert.equal(f.check.call(f.owner, 'render', id, 5, resource, priority), 'reservation');
  }
  const check = wrapRenderAdmissionCheck(() => 'reservation', () => ({ lane: f.lane, priority: '020' }));
  assert.equal(check('render', 'ready', 5, 'remotion', '999'), 'reservation');
});

test('omitted caller priority resolves from exact registered waiter', () => {
  const f = fixture();
  assert.equal(f.check.call(f.owner, 'render', 'ready', 5, 'remotion'), null);
});

test('missing effective priority fails closed', () => {
  const f = fixture();
  const check = wrapRenderAdmissionCheck(() => 'reservation', () => ({ lane: f.lane }));
  assert.equal(check('render', 'ready', 5, 'remotion'), 'reservation');
});

test('does not lend to unsupported resources or other lanes', () => {
  const check = wrapRenderAdmissionCheck(() => 'reservation', () => { throw Error('out of scope'); });
  for (const [lane, resource] of [['render', 'geomap'], ['render', 'ffmpeg'],
    ['render', undefined], ['ffmpeg', 'remotion'], ['image', 'frameshift']]) {
    assert.equal(check(lane, 'ready', 5, resource, '020'), 'reservation');
  }
});

test('preserves this, exact original args, priority, extra args and wrapper descriptors', () => {
  const f = fixture({ waiters: [waiter('blocked', '010', 'frameshift'), waiter('ready')] });
  const symbol = Symbol('other-wrapper');
  const descriptors = {
    mapAdmissionVersion: { value: 'map-v1', configurable: false },
    originalAdmissionCheck: { value: () => {}, enumerable: true },
    ffmpegAdmissionVersion: { get: () => 'ffmpeg-v1', configurable: true },
    [symbol]: { value: 'symbol-marker' },
  };
  Object.defineProperties(f.original, descriptors);
  const stateCalls = [];
  const check = wrapRenderAdmissionCheck(f.original, function (...args) {
    assert.equal(this, f.owner);
    stateCalls.push(args);
    return f.getState(...args);
  });
  const extra = { opaque: true };
  const args = ['render', 'ready', 5, 'remotion', '020', extra];
  assert.equal(check.apply(f.owner, args), null);
  assert.deepEqual(f.calls[0], args);
  assert.deepEqual(f.calls[1], ['render', 'blocked', 5, 'frameshift', '010', extra]);
  assert.deepEqual(stateCalls, [['ready', '020']]);
  for (const key of Reflect.ownKeys(descriptors)) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(check, key),
      Object.getOwnPropertyDescriptor(f.original, key));
  }
  assert.equal(wrapRenderAdmissionCheck(check, f.getState), check);
});

for (const stop of ['resource', 'reservation']) {
  test(`FIFO selector recovers native ${stop} head stop and preserves existing order`, () => {
    const waiters = [waiter('blocked', '010', 'frameshift'), waiter('first'), waiter('second')];
    const f = fixture({ waiters });
    const result = { waiter: null, reason: stop, nativeDetail: 1 };
    const seen = [];
    const original = function (...args) {
      assert.equal(this, f.owner);
      assert.deepEqual(args, ['render', f.lane, 5, 'extra']);
      return result;
    };
    const choose = wrapRenderWaiterChoice(original, function (...args) {
      assert.equal(this, f.owner);
      seen.push(args);
      return f.check.apply(this, args);
    });
    const before = structuredClone(f.lane);
    const selected = choose.call(f.owner, 'render', f.lane, 5, 'extra');
    assert.equal(selected.waiter, waiters[1]);
    assert.equal(selected.reason, null);
    assert.equal(selected.nativeDetail, 1);
    assert.deepEqual(seen, [
      ['render', 'blocked', 5, 'frameshift', '010'],
      ['render', 'first', 5, 'remotion', '020'],
    ]);
    assert.deepEqual(f.lane, before);
  });
}

test('selector does not ignore per-candidate native guards or unsupported resources', () => {
  const waiters = [waiter('map', '001', 'geomap'), waiter('memory', '010'),
    waiter('cooldown', '011'), waiter('license', '012'), waiter('cancel', '013'),
    waiter('resource', '014', 'frameshift'), waiter('reservation', '015'), waiter('ready')];
  const f = fixture({ waiters });
  for (const w of waiters.slice(1, -1)) f.denied.set(w.jobId, w.jobId);
  f.denied.set('map', 'resource');
  // A reservation-only higher-priority waiter still wins before this final waiter.
  f.denied.set('reservation', 'memory');
  const result = { waiter: null, reason: 'resource' };
  const choose = wrapRenderWaiterChoice(() => result, f.check);
  assert.equal(choose.call(f.owner, 'render', f.lane, 5).waiter, waiters.at(-1));
  assert.ok(!f.calls.some(args => args[1] === 'map' && args[4] === '001' && args[3] === 'remotion'));
});

for (const reason of ['lane', 'memory', 'cooldown', 'license', 'cancel', null, 'unknown']) {
  test(`selector preserves native ${reason} denial without probing`, () => {
    const result = { waiter: null, reason };
    const choose = wrapRenderWaiterChoice(() => result, () => { throw Error('probed denial'); });
    assert.equal(choose('render', { activeTotal: 2, waiters: [waiter('ready')] }, 5), result);
  });
}

test('selector keeps native choice, non-render lane, no-work, full or invalid cap unchanged', () => {
  const chosen = { waiter: waiter('native'), reason: null };
  const empty = { waiter: null, reason: 'reservation' };
  const noProbe = () => { throw Error('unexpected probe'); };
  assert.equal(wrapRenderWaiterChoice(() => chosen, noProbe)('render', {}, 5), chosen);
  const choose = wrapRenderWaiterChoice(() => empty, noProbe);
  assert.equal(choose('ffmpeg', { activeTotal: 2, waiters: [waiter('ready')] }, 5), empty);
  assert.equal(choose('render', { activeTotal: 2, waiters: [] }, 5), empty);
  assert.equal(choose('render', { activeTotal: 5, waiters: [waiter('ready')] }, 5), empty);
  assert.equal(choose('render', { activeTotal: 2, waiters: [waiter('ready')] }, Infinity), empty);
});

test('selector returns original result when no supported waiter is actually admitted', () => {
  const result = { waiter: null, reason: 'resource' };
  const lane = { activeTotal: 2, waiters: [waiter('map', '010', 'geomap'), waiter('ready')] };
  for (const denial of ['resource', 'reservation', 'memory', 'cooldown', 'license', 'cancel', 'lane', undefined]) {
    const seen = [];
    const choose = wrapRenderWaiterChoice(() => result, (...args) => { seen.push(args); return denial; });
    assert.equal(choose('render', lane, 5), result);
    assert.deepEqual(seen, [['render', 'ready', 5, 'remotion', '020']]);
  }
});

test('selector preserves wrapper descriptors and is idempotent', () => {
  const original = () => ({ waiter: null, reason: 'reservation' });
  Object.defineProperty(original, 'mapWaiterVersion', { value: 'map-v1', enumerable: true });
  const choose = wrapRenderWaiterChoice(original, () => null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(choose, 'mapWaiterVersion'),
    Object.getOwnPropertyDescriptor(original, 'mapWaiterVersion'));
  assert.equal(wrapRenderWaiterChoice(choose, () => null), choose);
});
