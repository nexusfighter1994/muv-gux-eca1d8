'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../node/auth-retry.cjs');

class AuthUnavailable extends Error {
  constructor(retryAt = null) {
    super('Render authorization is temporarily unavailable. Your files are safe; retry shortly. Reference: RP-TEST');
    this.name = 'RenderAuthorizationUnavailableError'; this.code = 'authorization_unavailable'; this.retryable = true; this.retryAt = retryAt;
  }
}
const cfg = over => () => ({ ...A.DEFAULTS, ...over });
// Virtual clock: sleep only advances the time, so tests run instantly.
function clock(start = Date.parse('2026-11-20T09:03:00Z')) {
  let t = start; const slept = [];
  return { now: () => t, sleep: async ms => { slept.push(ms); t += ms; }, slept, total: () => slept.reduce((a, b) => a + b, 0) };
}
const args = (jobId = 'job-1') => ({ jobId, chunkNumber: 10, segment: { segment_id: 4 } });

test('a successful dispatch passes through untouched, with this and arguments', async () => {
  const c = clock(); const self = { tag: 1 }; let seen;
  const w = A.wrapDispatch(function (a) { seen = [this, a]; return { status: 'succeeded', outputPath: '/x.mp4' }; }, { ...c, read: cfg() });
  const a = args();
  const r = await w.call(self, a);
  assert.deepStrictEqual(r, { status: 'succeeded', outputPath: '/x.mp4' });
  assert.strictEqual(seen[0], self); assert.strictEqual(seen[1], a);
  assert.strictEqual(c.slept.length, 0); assert.strictEqual(w.stats.waits, 0);
});

test('other errors and other failed results are not retried', async () => {
  const c = clock(); let calls = 0;
  const boom = Object.assign(new Error('fflow POST /v1/render: 500'), { code: 'http_500' });
  const w = A.wrapDispatch(async () => { calls++; throw boom; }, { ...c, read: cfg() });
  await assert.rejects(() => w(args()), e => e === boom);
  assert.strictEqual(calls, 1);
  const failed = { status: 'failed', error: 'No suitable b-roll video found for segment' };
  const w2 = A.wrapDispatch(async () => failed, { ...c, read: cfg() });
  assert.strictEqual(await w2(args()), failed);
  assert.strictEqual(c.slept.length, 0);
});

test('authorization unavailable: waits, dispatches again and returns the later result', async () => {
  const c = clock(); let calls = 0; const logs = [];
  const w = A.wrapDispatch(async () => { calls++; if (calls <= 2) throw new AuthUnavailable(); return { status: 'succeeded' }; },
    { ...c, read: cfg(), log: m => logs.push(m) });
  const r = await w(args('8fe24646-aaaa'));
  assert.deepStrictEqual(r, { status: 'succeeded' });
  assert.strictEqual(calls, 3);
  assert.strictEqual(c.total(), 20000 + 40000, 'backoff 20 s then 40 s');
  assert.ok(c.slept.every(ms => ms <= 5000), 'sleeps in slices so an abort is noticed');
  assert.deepStrictEqual({ waits: w.stats.waits, recovered: w.stats.recovered, gaveUp: w.stats.gaveUp, waiting: w.stats.waiting }, { waits: 2, recovered: 1, gaveUp: 0, waiting: 0 });
  assert.strictEqual(logs.length, 1); assert.match(logs[0], /8fe24646 chunk 10 segment 4/);
});

test('uses the retry time the app announces, bounded by min and max delay', async () => {
  const start = Date.parse('2026-11-20T09:03:00Z');
  assert.strictEqual(A.nextDelayMs({ retryAt: '2026-11-20T09:06:00.000Z' }, 0, A.DEFAULTS, start), 185000);
  assert.strictEqual(A.nextDelayMs({ retryAt: '2026-11-20T09:30:00.000Z' }, 0, A.DEFAULTS, start), 240000, 'capped at maxDelaySec');
  assert.strictEqual(A.nextDelayMs({ retryAt: '2026-11-20T09:03:01.000Z' }, 0, A.DEFAULTS, start), 20000, 'never below minDelaySec');
  assert.strictEqual(A.nextDelayMs({ retryAt: 'garbage' }, 3, A.DEFAULTS, start), 160000);
  assert.strictEqual(A.nextDelayMs({}, 50, A.DEFAULTS, start), 240000);
});

test('gives up after maxWaitMinutes and hands back the original error', async () => {
  const c = clock(); let calls = 0; const err = new AuthUnavailable();
  const w = A.wrapDispatch(async () => { calls++; throw err; }, { ...c, read: cfg({ maxWaitMinutes: 10 }), log: () => {} });
  await assert.rejects(() => w(args()), e => e === err);
  assert.ok(c.total() >= 10 * 60000 && c.total() < 15 * 60000, `waited ${c.total()} ms`);
  assert.ok(calls >= 4);
  assert.strictEqual(w.stats.gaveUp, 1); assert.strictEqual(w.stats.recovered, 0);
});

test('a failed result that only carries the authorization message is retried too', async () => {
  const c = clock(); let calls = 0;
  const w = A.wrapDispatch(async () => (++calls === 1
    ? { status: 'failed', error: 'Render authorization is temporarily unavailable. Your files are safe; retry shortly. Reference: RP-1' }
    : { status: 'succeeded' }), { ...c, read: cfg(), log: () => {} });
  assert.deepStrictEqual(await w(args()), { status: 'succeeded' });
  assert.strictEqual(calls, 2);
});

test('found along the cause chain; a denied or non-retryable authorization is never retried', async () => {
  const wrappedErr = new Error('chunk failed', { cause: new AuthUnavailable() });
  assert.ok(A.authError(wrappedErr));
  const denied = Object.assign(new Error('Media preprocessing could not complete for this render'), { name: 'RenderPermitDeniedError', code: 'render_permit_denied', retryable: false });
  assert.strictEqual(A.authError(denied), null);
  const hard = Object.assign(new AuthUnavailable(), { retryable: false });
  assert.strictEqual(A.authError(hard), null);
  assert.strictEqual(A.authError(null), null); assert.strictEqual(A.authError('text'), null);
  const c = clock(); let calls = 0;
  const w = A.wrapDispatch(async () => { calls++; throw denied; }, { ...c, read: cfg() });
  await assert.rejects(() => w(args()), e => e === denied);
  assert.strictEqual(calls, 1); assert.strictEqual(c.slept.length, 0);
});

test('switched off, aborted jobs and an aborted signal pass the error straight through', async () => {
  const err = new AuthUnavailable();
  for (const extra of [{ read: cfg({ enabled: false }) }, { read: cfg(), isAborted: () => true }]) {
    const c = clock(); let calls = 0;
    const w = A.wrapDispatch(async () => { calls++; throw err; }, { ...c, ...extra });
    await assert.rejects(() => w(args()), e => e === err);
    assert.strictEqual(calls, 1); assert.strictEqual(c.slept.length, 0);
  }
  const c = clock(); let calls = 0;
  const w = A.wrapDispatch(async () => { calls++; throw err; }, { ...c, read: cfg() });
  await assert.rejects(() => w({ ...args(), deps: { signal: { aborted: true } } }), e => e === err);
  assert.strictEqual(calls, 1);
});

test('an abort during the wait ends the wait early and returns the original error', async () => {
  const err = new AuthUnavailable(); let stopped = false; let t = 0; const slept = [];
  const w = A.wrapDispatch(async () => { throw err; }, { now: () => t, read: cfg(), log: () => {}, isAborted: () => stopped,
    sleep: async ms => { slept.push(ms); t += ms; if (slept.length === 2) stopped = true; } });
  await assert.rejects(() => w(args()), e => e === err);
  assert.strictEqual(slept.length, 2, 'stopped after two 5-s slices instead of the full 20 s');
  assert.strictEqual(w.stats.waiting, 0);
});

test('helper failures never change the outcome; wrapping twice is a no-op', async () => {
  const err = new AuthUnavailable(); let calls = 0;
  const c = clock();
  const w = A.wrapDispatch(async () => { calls++; if (calls === 1) throw err; return { status: 'succeeded' }; },
    { ...c, read: () => { throw new Error('config unreadable'); }, isAborted: () => { throw new Error('scheduler gone'); }, log: () => { throw new Error('log broken'); } });
  assert.deepStrictEqual(await w(args()), { status: 'succeeded' });
  assert.strictEqual(A.wrapDispatch(w), w);
  assert.throws(() => A.wrapDispatch(null), TypeError);
  assert.strictEqual(typeof w.__vfOriginal, 'function');
});

test('config reader keeps defaults for bad values', () => {
  const c = A.readConfig('/x', () => '{"maxWaitMinutes":"x","minDelaySec":30,"maxDelaySec":5,"enabled":false}');
  assert.strictEqual(c.maxWaitMinutes, 45); assert.strictEqual(c.minDelaySec, 30); assert.strictEqual(c.maxDelaySec, 30); assert.strictEqual(c.enabled, false);
  assert.deepStrictEqual(A.readConfig('/missing', () => { throw new Error('x'); }), { ...A.DEFAULTS });
  assert.strictEqual(A.readConfig('/x', () => '[1,2]').enabled, true);
});
