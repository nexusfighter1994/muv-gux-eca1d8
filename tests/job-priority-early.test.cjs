'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jp = require('../node/job-priority.cjs');

const key = (basis, early, extra = {}) => jp.rankKey('j', { basis, ...extra }, { started_at: '2026-10-18T05:00:00Z' }, { early });

test('finish-first by default: assembly ... preparation last', () => {
  const order = ['assembly', 'chunk-composition', 'segments', 'planning', 'preparation'].map(b => key(b, false));
  assert.deepEqual([...order].sort(), order);
});

test('early-phase priority: planning and preparation first, then finish-first from segment rendering on', () => {
  const order = ['planning', 'preparation', 'assembly', 'chunk-composition', 'segments'].map(b => key(b, true));
  assert.deepEqual([...order].sort(), order);
  assert.ok(key('planning', true, { plannedChunks: 9, totalChunks: 10 }) < key('planning', true, { plannedChunks: 1, totalChunks: 10 }), 'further along first');
});

test('the manager follows the switch per tick and rewrites waiting work', () => {
  let early = false;
  const jobs = new Map([['a', { priority: 'x' }], ['b', { priority: 'x' }]]);
  const lane = { waiters: [{ jobId: 'b', priority: 'x' }] };
  const detail = { a: { basis: 'segments', completedSegments: 1, totalSegments: 10 }, b: { basis: 'preparation', progress: 0.05 } };
  const m = jp.createJobPriority({ getJobs: () => jobs, getLanes: () => new Map([['ffmpeg', lane]]), progress: id => detail[id],
    getDb: () => null, setTimer: () => null, settings: () => ({ earlyPhasePriority: early }) });
  m.tick();
  assert.ok(jobs.get('a').priority < jobs.get('b').priority, 'off: the rendering job first');
  early = true; m.tick();
  assert.ok(jobs.get('b').priority < jobs.get('a').priority, 'on: the preparing job first');
  assert.equal(lane.waiters[0].priority, jobs.get('b').priority);
  assert.equal(m.stats.early, true);
});
