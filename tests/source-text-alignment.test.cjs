'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { repairSourceTimeline } = require('../node/source-text-alignment.cjs');

function partition(cuts, duration) {
  const boundaries = [0];
  for (let i = 1; i < cuts.length; i++) {
    const b = Math.round(Math.max(cuts[i - 1].end_time, cuts[i].start_time) * 1000) / 1000;
    if (!Number.isFinite(b) || b <= boundaries.at(-1) || b >= cuts[i].end_time)
      throw Error('partitionSourceTimelineCuts: invalid/non-monotonic boundary before chunk ' + (i + 1));
    boundaries.push(b);
  }
  boundaries.push(duration);
  return cuts.map((c, i) => ({ ...c, start_time: boundaries[i], end_time: boundaries[i + 1] }));
}
function fixture() {
  const text = ['日本語の音声を正確に分割します', '最初の説明には少し違いがあります', '途中の文章も順番通りに続きます', '最後の重要な説明を省略しません', '結論まで音声と内容を保ちます'];
  const transcript = text.join('').replace('正確に', '').replace('少し違い', '違い').replace('重要な', '大事な');
  const words = [...transcript].map((text, i) => ({ text, start: i, end: i + .8 }));
  return { language: 'Japanese', durationSeconds: words.length + .5, words,
    scriptChunks: text.map((script_chunk, i) => ({ chunk_number: i + 1, script_chunk })),
    aligned: text.map((_, i) => ({ chunk_number: i + 1, start_time: i < 3 ? i * 15 : words.length - 1, end_time: i < 3 ? (i + 1) * 15 : words.length - .2 })), partition };
}
test('repairs collapsed boundaries using transcript text and retains full audio coverage', async () => {
  const f = fixture();
  assert.throws(() => partition(f.aligned, f.durationSeconds));
  const before = JSON.stringify(f);
  const repaired = await repairSourceTimeline(f);
  const cuts = partition(repaired, f.durationSeconds);
  assert.equal(cuts.length, 5);
  assert.equal(cuts[0].start_time, 0);
  assert.equal(cuts.at(-1).end_time, f.durationSeconds);
  assert.ok(cuts.every(c => c.end_time > c.start_time));
  const last = f.words.findIndex((w, i) => f.words.slice(i, i + 4).map(x => x.text).join('') === '結論まで');
  assert.ok(Math.abs(repaired[4].start_time - last) < .04);
  assert.equal(JSON.stringify(f), before);
});
test('valid native alignment is returned by identity', async () => {
  const f = fixture(); f.aligned = [{ chunk_number: 1, start_time: 0, end_time: 3 }];
  assert.equal(await repairSourceTimeline(f), f.aligned);
});
test('unrelated partition failures and unsupported languages remain native', async () => {
  const f = fixture(); f.partition = () => { throw Error('different validation error'); };
  assert.equal(await repairSourceTimeline(f), f.aligned);
  const g = fixture(); g.language = 'English';
  assert.equal(await repairSourceTimeline(g), g.aligned);
});
test('unrelated text and invalid timestamp input fail closed', async () => {
  const f = fixture(); f.words = f.words.map(w => ({ ...w, text: '魚' }));
  await assert.rejects(repairSourceTimeline(f), /alignment repair refused/);
  const g = fixture(); g.words[2].start = NaN;
  await assert.rejects(repairSourceTimeline(g), /alignment repair refused/);
});
test('pre-aborted operation and exhausted diff budget fail closed', async () => {
  const f = fixture(); f.signal = AbortSignal.abort();
  await assert.rejects(repairSourceTimeline(f), { name: 'AbortError' });
  const g = fixture(); g.maxEditLength = 0;
  await assert.rejects(repairSourceTimeline(g), /alignment repair refused/);
});
test('repeated text retains globally monotonic source order', async () => {
  const f = fixture();
  f.scriptChunks[2].script_chunk = f.scriptChunks[1].script_chunk;
  const text = f.scriptChunks.map(c => c.script_chunk).join('').replace('正確に', '');
  f.words = [...text].map((text, i) => ({ text, start: i, end: i + .8 }));
  f.durationSeconds = f.words.length + .5;
  const repaired = await repairSourceTimeline(f);
  assert.doesNotThrow(() => partition(repaired, f.durationSeconds));
  assert.ok(repaired[2].start_time > repaired[1].start_time + 5);
});
test('native job cancellation is checked before and after asynchronous matching', async () => {
  const f = fixture(); let checks = 0;
  f.checkAbort = () => { if (++checks === 2) throw Error('job paused'); };
  await assert.rejects(repairSourceTimeline(f), /job paused/);
});
test('async matching leaves the event loop responsive and reports metadata only', async () => {
  const f = fixture(); let ticks = 0, receipt;
  const timer = setInterval(() => ticks++, 2);
  try {
    f.onRepair = r => { receipt = r; };
    await repairSourceTimeline(f);
    assert.ok(ticks > 0);
    assert.deepEqual(Object.keys(receipt).sort(), ['algorithm','chunks','matched','scriptGraphemes','transcriptGraphemes']);
  } finally { clearInterval(timer); }
});
test('short event-loop congestion does not consume asynchronous diff edit passes', async () => {
  const f = fixture();
  f.timeoutMs = 1000;
  const timer = setInterval(() => { const until = Date.now() + 250; while (Date.now() < until) {} }, 20);
  try { assert.equal((await repairSourceTimeline(f)).length, 5); }
  finally { clearInterval(timer); }
});
test('worker deadlines and mid-flight cancellation release capacity exactly once', async () => {
  for (let i = 0; i < 3; i++) {
    const f = fixture(); f.timeoutMs = 1;
    await assert.rejects(repairSourceTimeline(f), /alignment repair refused/);
    const g = fixture(), controller = new AbortController(); g.signal = controller.signal;
    const promise = repairSourceTimeline(g); controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
  }
  assert.equal((await repairSourceTimeline(fixture())).length, 5);
});
