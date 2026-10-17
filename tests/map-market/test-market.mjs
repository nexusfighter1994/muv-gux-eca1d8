import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture() {
  let now = 0;
  const timers = new Map();
  let id = 0;
  const source = fs.readFileSync(new URL('./custom.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const MARKET_TIMEOUT_MS =');
  const end = source.indexOf('// A chunk composition', start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({
    console: { warn() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) {
      const timer = { id: ++id, due: now + delay, fn, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timers.delete(timer.id); },
  });
  vm.runInContext(source.slice(start, end).replaceAll('export ', '') +
    '\nglobalThis.api = { wrapMarketCheck, marketGuardStats };', context);
  return {
    ...context.api,
    timerCount: () => timers.size,
    async advance(ms) {
      now += ms;
      for (const timer of [...timers.values()]) {
        if (timer.due <= now) { timers.delete(timer.id); timer.fn(); }
      }
      await flush();
    },
  };
}

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const never = () => new Promise(() => {});

test('300 callers share one market deadline, operation, and timeout', async () => {
  const f = fixture();
  const cache = new Map();
  let calls = 0;
  const guarded = f.wrapMarketCheck(opts => {
    calls++;
    const entry = cache.get(opts.model) || { promise: never() };
    cache.set(opts.model, entry);
    return entry.promise;
  }, () => cache);
  const pending = Array.from({ length: 300 }, () => guarded({ model: 'luna' }));
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.timerCount(), 1);
  await f.advance(20000);
  const results = await Promise.all(pending);
  assert.ok(results.every(r => r.eligible && r.reason === 'market_unavailable_fail_open'));
  assert.equal(f.marketGuardStats.timeouts, 1);
  assert.equal(cache.has('luna'), false);
});

test('a timed-out generation cannot delete a newer native cache entry', async () => {
  const f = fixture();
  const cache = new Map();
  const old = { promise: never() };
  const fresh = { promise: never() };
  const guarded = f.wrapMarketCheck(() => { cache.set('luna', old); return old.promise; }, () => cache);
  const pending = guarded({ model: 'luna' });
  await flush();
  cache.set('luna', fresh);
  await f.advance(20000);
  await pending;
  assert.equal(cache.get('luna'), fresh);
});

test('a short timeout backoff avoids a new market request storm', async () => {
  const f = fixture();
  const cache = new Map();
  let calls = 0;
  const guarded = f.wrapMarketCheck(() => { calls++; return never(); }, () => cache);
  const pending = guarded({ model: 'luna' });
  await flush();
  await f.advance(20000);
  await pending;
  const second = guarded({ model: 'luna' });
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.timerCount(), 0);
  assert.equal((await second).eligible, true);
  await f.advance(15001);
  const third = guarded({ model: 'luna' });
  await flush();
  assert.equal(calls, 2);
  await f.advance(20000);
  await third;
});

test('valid policy denials and successful prices are unchanged', async () => {
  const f = fixture();
  const denial = { eligible: false, reason: 'discount_guard', price: { output: 2 } };
  const guarded = f.wrapMarketCheck(() => denial, () => new Map());
  assert.equal(await guarded({ model: 'luna' }), denial);
  assert.equal(f.timerCount(), 0);
  assert.equal(f.marketGuardStats.timeouts, 0);
});

test('models use separate deadlines and preserve invocation context', async () => {
  const f = fixture();
  const seen = [];
  const receiver = { marker: 42 };
  const guarded = f.wrapMarketCheck(function (opts) {
    seen.push([this.marker, opts.model]); return never();
  }, () => new Map());
  const a = guarded.call(receiver, { model: 'a' });
  const b = guarded.call(receiver, { model: 'b' });
  await flush();
  assert.deepEqual(seen, [[42, 'a'], [42, 'b']]);
  await f.advance(20000);
  await Promise.all([a, b]);
  assert.equal(f.marketGuardStats.timeouts, 2);
});

test('native errors retain their identity and clear the guarded flight', async () => {
  const f = fixture();
  const error = new Error('original');
  let calls = 0;
  const guarded = f.wrapMarketCheck(() => { calls++; throw error; }, () => new Map());
  await assert.rejects(guarded({ model: 'luna' }), e => e === error);
  await assert.rejects(guarded({ model: 'luna' }), e => e === error);
  assert.equal(calls, 2);
  assert.equal(f.timerCount(), 0);
});
