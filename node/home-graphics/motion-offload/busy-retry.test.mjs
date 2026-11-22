import assert from 'node:assert';
import { sendWithBusyRetry, parseKnob, DEFAULTS, stats } from './busy-retry.mjs';

const cfg = over => () => ({ ...DEFAULTS, ...over });
const reply = status => ({ status, ok: status === 200, arrayBuffer: async () => new ArrayBuffer(0) });

// harness: a clock that only moves through send (duration per call) and sleep
function harness(script) {
  let t = 1_000_000, n = 0;
  const ids = [], sleeps = [];
  return {
    now: () => t, ids, sleeps,
    send: async id => { const step = script[Math.min(n, script.length - 1)]; n += 1; ids.push(id); t += step.ms; return { response: reply(step.status), payload: { id } }; },
    sleep: async ms => { sleeps.push(ms); t += ms; },
    newId: () => 'id' + (ids.length + 1),
    deadline: () => t + 300000,
  };
}

// knob
assert.deepStrictEqual(parseKnob(''), DEFAULTS);
assert.deepStrictEqual(parseKnob('{"enabled":false,"waitMs":1000,"maxWaitMs":10000,"fastMs":500,"minRenderMs":30000}'),
  { enabled: false, waitMs: 1000, maxWaitMs: 10000, fastMs: 500, minRenderMs: 30000 });
assert.deepStrictEqual(parseKnob('{"waitMs":1,"maxWaitMs":-5,"fastMs":"x","minRenderMs":0}'), DEFAULTS);

// 1. a normal answer is returned at once, same id
{
  const h = harness([{ status: 200, ms: 40000 }]);
  const r = await sendWithBusyRetry({ send: h.send, firstId: 'id1', homeDeadline: h.deadline(), settings: cfg(), now: h.now, sleep: h.sleep, newId: h.newId });
  assert.deepStrictEqual([r.id, r.tries, r.response.status, h.sleeps.length, r.payload.id], ['id1', 1, 200, 0, 'id1']);
}
// 2. two instant 503s, then Home has a slot: new id per attempt, the payload of the last attempt comes back
{
  const before = { ...stats };
  const h = harness([{ status: 503, ms: 80 }, { status: 503, ms: 80 }, { status: 200, ms: 30000 }]);
  const r = await sendWithBusyRetry({ send: h.send, firstId: 'id1', homeDeadline: h.deadline(), settings: cfg(), now: h.now, sleep: h.sleep, newId: h.newId });
  assert.deepStrictEqual([r.id, r.tries, r.response.status], ['id3', 3, 200]);
  assert.deepStrictEqual(h.ids, ['id1', 'id2', 'id3']);
  assert.deepStrictEqual(h.sleeps, [2500, 2500]);
  assert.strictEqual(r.payload.id, 'id3');
  assert.deepStrictEqual([stats.busy - before.busy, stats.retries - before.retries, stats.recovered - before.recovered], [2, 2, 1]);
}
// 3. a slow 503 is a real render failure: no retry
{
  const h = harness([{ status: 503, ms: 45000 }]);
  const r = await sendWithBusyRetry({ send: h.send, firstId: 'id1', homeDeadline: h.deadline(), settings: cfg(), now: h.now, sleep: h.sleep, newId: h.newId });
  assert.deepStrictEqual([r.tries, r.response.status, h.sleeps.length], [1, 503, 0]);
}
// 4. other errors are not retried
{
  const h = harness([{ status: 500, ms: 50 }]);
  const r = await sendWithBusyRetry({ send: h.send, firstId: 'id1', homeDeadline: h.deadline(), settings: cfg(), now: h.now, sleep: h.sleep, newId: h.newId });
  assert.deepStrictEqual([r.tries, r.response.status], [1, 500]);
}
// 5. Home stays full: give up after maxWaitMs and hand the 503 back (the caller falls back as before)
{
  const before = stats.gaveUp;
  const h = harness([{ status: 503, ms: 80 }]);
  const r = await sendWithBusyRetry({ send: h.send, firstId: 'id1', homeDeadline: h.deadline(), settings: cfg({ maxWaitMs: 10000 }), now: h.now, sleep: h.sleep, newId: h.newId });
  assert.deepStrictEqual([r.tries, r.response.status, h.sleeps.length], [5, 503, 4]);
  assert.strictEqual(stats.gaveUp - before, 1);
}
// 6. too little of the Home deadline left for a render: no waiting
{
  const h = harness([{ status: 503, ms: 80 }]);
  const r = await sendWithBusyRetry({ send: h.send, firstId: 'id1', homeDeadline: h.now() + 61000, settings: cfg(), now: h.now, sleep: h.sleep, newId: h.newId });
  assert.deepStrictEqual([r.tries, h.sleeps.length], [1, 0]);
}
// 7. switched off: behaves like before
{
  const h = harness([{ status: 503, ms: 80 }]);
  const r = await sendWithBusyRetry({ send: h.send, firstId: 'id1', homeDeadline: h.deadline(), settings: cfg({ enabled: false }), now: h.now, sleep: h.sleep, newId: h.newId });
  assert.deepStrictEqual([r.tries, h.sleeps.length], [1, 0]);
}
// 8. an abort during the wait is passed on
{
  const h = harness([{ status: 503, ms: 80 }]);
  const controller = new AbortController();
  const p = sendWithBusyRetry({ send: h.send, firstId: 'id1', homeDeadline: Date.now() + 300000, signal: controller.signal, settings: cfg({ waitMs: 20000 }) });
  setTimeout(() => controller.abort(new Error('scope ended')), 20);
  await assert.rejects(p, /scope ended/);
}
// 9. a failing send (network) is passed on
await assert.rejects(sendWithBusyRetry({ send: async () => { throw new Error('fetch failed'); }, firstId: 'id1', homeDeadline: Date.now() + 300000, settings: cfg() }), /fetch failed/);

console.log('busy-retry tests ok');
