'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require(process.env.TQ_MODULE || '../node/tts-queue-full.cjs');

// Stand-in for the native function: the plan lists what each submission attempt does.
function native(plan) {
  const calls = [];
  const submit = async ({ onProviderStatus, chunkNumber = 1, chunkCount = 3, ...rest }) => {
    const step = plan[calls.length] ?? 'ok';
    calls.push({ chunkNumber, ...rest });
    const event = (errorCode, outcome) => onProviderStatus({ level: 'warn', message: 'OpenSpeaker task submission failed — automatic resubmission stopped to avoid duplicate charges',
      data: { provider: 'ai33pro', phase: 'submission', errorCode, outcome, chunkNumber, chunkCount, chars: 10 } });
    if (step === 'queue-full') { event('http_429', 'failed'); throw Object.assign(Error('HTTP 429: You have too many tasks in queue (50/50)'), { code: 'http_429', noRetry: true }); }
    if (step === 'http-500') { event('http_500', 'failed'); throw Object.assign(Error('HTTP 500'), { code: 'http_500', noRetry: true }); }
    if (step === 'unknown') { event('timeout', 'unknown'); throw Object.assign(Error('timeout'), { code: 'timeout', noRetry: true }); }
    if (step === 'poll-429') throw Object.assign(Error('HTTP 429 while polling'), { code: 'http_429', noRetry: true });   // no submission event
    if (step === 'poll-fail') { onProviderStatus({ level: 'warn', message: 'status endpoint busy', data: { provider: 'ai33pro', phase: 'poll' } }); throw Object.assign(Error('task failed'), { code: 'task_failed' }); }
    onProviderStatus({ level: 'info', message: 'task running', data: { provider: 'ai33pro', phase: 'poll' } });
    return '/work/tts-chunk-' + chunkNumber + '.mp3';
  };
  return { submit, calls };
}
const world = (plan, extra = {}) => {
  const n = native(plan), events = [], sleeps = []; let time = 0;
  const options = { waitMs: 60000, maxWaitMs: 3600000, sleep: async ms => { sleeps.push(ms); time += ms; }, now: () => time, jitter: () => 0, exists: () => true, ...extra };
  const args = { headers: { k: 'v' }, voiceId: 'voice', speed: 1, textChunk: 'text', workDir: '/work', chunkNumber: 2, chunkCount: 3, onProviderStatus: info => events.push(info) };
  return { ...n, events, sleeps, options, args };
};

test('success passes straight through, events forwarded, same arguments', async () => {
  const w = world(['ok']);
  assert.equal(await mod.run(w.submit, w.args, w.options), '/work/tts-chunk-2.mp3');
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.calls[0], { chunkNumber: 2, headers: { k: 'v' }, voiceId: 'voice', speed: 1, textChunk: 'text', workDir: '/work' });
  assert.deepEqual(w.events.map(e => e.message), ['task running']);
  assert.deepEqual(w.sleeps, []);
});

test('queue full twice: waits 60 s each time, submits again, the native "stopped" warning is not shown', async () => {
  const w = world(['queue-full', 'queue-full', 'ok']);
  assert.equal(await mod.run(w.submit, w.args, w.options), '/work/tts-chunk-2.mp3');
  assert.equal(w.calls.length, 3);
  assert.deepEqual(w.sleeps, [60000, 60000]);
  assert.equal(w.events.length, 2);
  assert.match(w.events[0].message, /queue is full \(HTTP 429\): nothing was submitted or charged; waiting 60s/);
  assert.deepEqual(w.events[0].data, { provider: 'ai33pro', phase: 'submission', errorCode: 'http_429', outcome: 'waiting', waits: 1, chunkNumber: 2, chunkCount: 3 });
  assert.equal(w.events[1].message, 'task running');
});

test('one waiting message at the first wait and then every fifth', async () => {
  const w = world([...Array(11).fill('queue-full'), 'ok']);
  await mod.run(w.submit, w.args, w.options);
  assert.deepEqual(w.events.filter(e => e.data?.outcome === 'waiting').map(e => e.data.waits), [1, 5, 10]);
});

test('never resubmits when acceptance is unknown or the failure is not a 429', async () => {
  for (const step of ['unknown', 'http-500']) {
    const w = world([step, 'ok']);
    await assert.rejects(mod.run(w.submit, w.args, w.options), e => e.noRetry === true);
    assert.equal(w.calls.length, 1, step);
    assert.equal(w.events.length, 1);
    assert.match(w.events[0].message, /automatic resubmission stopped/);
    assert.deepEqual(w.sleeps, []);
  }
});

test('a 429 that is not a rejected submission (status poll) is never resubmitted', async () => {
  const w = world(['poll-429', 'ok']);
  await assert.rejects(mod.run(w.submit, w.args, w.options), e => e.code === 'http_429');
  assert.equal(w.calls.length, 1);
  const v = world(['poll-fail', 'ok']);
  await assert.rejects(mod.run(v.submit, v.args, v.options), e => e.code === 'task_failed');
  assert.equal(v.calls.length, 1);
  assert.deepEqual(v.events.map(e => e.message), ['status endpoint busy']);
});

test('gives up after the maximum wait with the native warning and the native error', async () => {
  const w = world(Array(100).fill('queue-full'), { maxWaitMs: 180000 });
  await assert.rejects(mod.run(w.submit, w.args, w.options), e => e.code === 'http_429' && e.noRetry === true);
  assert.equal(w.calls.length, 4);                    // 0 s, 60 s, 120 s, 180 s
  assert.deepEqual(w.sleeps, [60000, 60000, 60000]);
  assert.match(w.events.at(-1).message, /automatic resubmission stopped/);
});

test('does not resubmit when the work folder of the job is gone', async () => {
  const w = world(['queue-full', 'ok'], { exists: () => false });
  await assert.rejects(mod.run(w.submit, w.args, w.options), e => e.code === 'http_429');
  assert.equal(w.calls.length, 1);
  assert.match(w.events[0].message, /automatic resubmission stopped/);
});

test('works without a status callback; jitter adds at most 10 s', async () => {
  const w = world(['queue-full', 'ok'], { jitter: () => 0.999 });
  delete w.args.onProviderStatus;
  assert.equal(await mod.run(w.submit, w.args, w.options), '/work/tts-chunk-2.mp3');
  assert.ok(w.sleeps[0] > 60000 && w.sleeps[0] <= 70000, String(w.sleeps[0]));
});

test('create returns a marked replacement with the configured wait', async () => {
  const w = world(['queue-full', 'ok']);
  const replacement = mod.create({ submit: w.submit, ...w.options });
  assert.equal(replacement.__vfQueueFull, 'tts-queue-full-v1');
  assert.equal(replacement.waitMs, 60000);
  assert.equal(replacement.maxWaitMs, 3600000);
  assert.equal(await replacement(w.args), '/work/tts-chunk-2.mp3');
  assert.equal(w.calls.length, 2);
  assert.throws(() => mod.create({}), TypeError);
  assert.equal(mod.WAIT_MS, 60000);
  assert.equal(mod.MAX_WAIT_MS, 3600000);
});
