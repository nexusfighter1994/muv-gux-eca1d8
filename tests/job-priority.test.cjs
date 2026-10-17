'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobPriority, rankKey } = require('../node/job-priority.cjs');

const detail = {
  assembly: { basis: 'assembly', progress: 0.9 },
  compose51: { basis: 'chunk-composition', totalChunks: 82, completedChunks: 51 },
  compose80: { basis: 'chunk-composition', totalChunks: 82, completedChunks: 80 },
  segments: { basis: 'segments', totalSegments: 400, completedSegments: 390 },
  planning: { basis: 'planning', totalChunks: 50, plannedChunks: 49 },
  prep: { basis: 'preparation', progress: 0.1 },
};
const rows = { a: '2026-10-14T05:00:00Z', b: '2026-10-13T05:00:00Z', c: '2026-10-16T05:00:00Z' };

test('further videos always rank higher; phase beats raw counts; start time breaks ties', () => {
  const order = [
    ['asm', detail.assembly, rows.c], ['c80', detail.compose80, rows.c], ['c51old', detail.compose51, rows.b],
    ['c51', detail.compose51, rows.a], ['seg', detail.segments, rows.b], ['plan', detail.planning, rows.b],
    ['prep', detail.prep, rows.b], ['unknown', null, rows.b],
  ].map(([id, d, s]) => [rankKey(id, d, { started_at: s, queued_at: '2026-10-11T18:00:00Z' }), id]);
  const sorted = [...order].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(x => x[1]);
  assert.deepEqual(sorted, ['asm', 'c80', 'c51old', 'c51', 'seg', 'plan', 'prep', 'unknown']);
  for (const [key] of order) { assert.ok(key > '', 'interactive "" stays first'); assert.ok(key < '￿'); }
});

test('5% buckets: one more finished chunk does not flip two similar videos', () => {
  const a = rankKey('a', { basis: 'chunk-composition', totalChunks: 100, completedChunks: 51 }, { started_at: rows.b });
  const b = rankKey('b', { basis: 'chunk-composition', totalChunks: 100, completedChunks: 52 }, { started_at: rows.a });
  assert.ok(a < b, 'same bucket keeps start order');
});

function world() {
  const jp = new Map([
    ['old', { priority: '2026-10-11T18:22:54.866Z|x|old' }],
    ['top', { priority: '2026-10-11T18:16:35.864Z|x|top' }],
  ]);
  const render = { waiters: [
    { jobId: 'old', priority: '2026-10-11T18:22:54.866Z|x|old', seq: 1 },
    { jobId: 'old', priority: '', seq: 2 },
    { jobId: 'top', priority: '2026-10-11T18:16:35.864Z|x|top', seq: 3 },
  ] };
  const AM = new Map([['render', render]]);
  const progress = { old: detail.compose51, top: detail.segments };
  const db = { prepare: () => ({ get: id => ({ started_at: id === 'old' ? rows.b : rows.c, queued_at: 'q' }) }) };
  let wakes = 0;
  const manager = createJobPriority({ getJobs: () => jp, getLanes: () => AM, progress: id => progress[id],
    getDb: () => db, wake: () => { wakes++; }, setTimer: () => ({}), clearTimer: () => {} });
  return { jp, render, progress, manager, wakes: () => wakes };
}

test('tick reprioritises registered jobs and exactly their own non-interactive waiters', () => {
  const w = world();
  assert.equal(w.manager.tick(), 2);
  assert.ok(w.jp.get('old').priority < w.jp.get('top').priority, 'composing video now outranks the segment video');
  assert.equal(w.render.waiters[0].priority, w.jp.get('old').priority);
  assert.equal(w.render.waiters[1].priority, '', 'interactive waiter untouched');
  assert.equal(w.render.waiters[2].priority, w.jp.get('top').priority);
  assert.equal(w.wakes(), 1);
  assert.equal(w.manager.stats.top[0].jobId, 'old');
  assert.equal(w.manager.tick(), 0, 'stable when nothing changed');
  assert.equal(w.wakes(), 1);
  w.progress.top = detail.assembly;
  assert.equal(w.manager.tick(), 1);
  assert.equal(w.manager.stats.top[0].jobId, 'top', 'reaching assembly moves a video to the very top');
});

test('broken progress or DB never throws into the scheduler', () => {
  const w = world();
  const broken = createJobPriority({ getJobs: () => w.jp, getLanes: () => new Map(), progress: () => { throw Error('db'); },
    getDb: () => ({ prepare: () => { throw Error('sqlite'); } }), setTimer: () => ({}), clearTimer: () => {} });
  assert.equal(broken.tick(), 2);
  for (const job of w.jp.values()) assert.match(job.priority, /^5\|/);
  const dead = createJobPriority({ getJobs: () => { throw Error('x'); }, getLanes: () => new Map(), progress: () => null, getDb: () => null });
  assert.equal(dead.tick(), 0);
  assert.equal(dead.stats.errors, 1);
});
