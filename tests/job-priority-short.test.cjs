'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jp = require('../node/job-priority.cjs');
const settingsModule = require('../node/scheduling-settings.cjs');

const row = { started_at: '2026-11-19T01:51:00Z', queued_at: '2026-11-19T01:51:00Z' };
const key = (id, detail, opts) => jp.rankKey(id, detail, row, opts);

test('short video in segment rendering ranks before a far advanced long one', () => {
  const short = key('s', { basis: 'segments', totalSegments: 194, completedSegments: 40 }, { early: true, shortMax: 400 });
  const long = key('l', { basis: 'segments', totalSegments: 2246, completedSegments: 1783 }, { early: true, shortMax: 400 });
  assert.ok(short < long, `${short} must sort before ${long}`);
});

test('off (shortMax 0) keeps plain finish-first', () => {
  const short = key('s', { basis: 'segments', totalSegments: 194, completedSegments: 40 }, { early: true });
  const long = key('l', { basis: 'segments', totalSegments: 2246, completedSegments: 1783 }, { early: true });
  assert.ok(long < short);
});

test('long video already composing chunks stays ahead of a less advanced short one', () => {
  const short = key('s', { basis: 'segments', totalSegments: 194, completedSegments: 40 }, { early: true, shortMax: 400 });
  const composing = key('c', { basis: 'chunk-composition', totalChunks: 301, completedChunks: 129 }, { early: true, shortMax: 400 });
  assert.ok(composing < short);
});

test('early phases still come first, limit is inclusive, other phases untouched', () => {
  const opts = { early: true, shortMax: 400 };
  assert.ok(key('p', { basis: 'preparation', progress: 0.05 }, opts) < key('s', { basis: 'segments', totalSegments: 100, completedSegments: 99 }, opts));
  assert.equal(jp.isShort({ basis: 'segments', totalSegments: 400 }, 400), true);
  assert.equal(jp.isShort({ basis: 'segments', totalSegments: 401 }, 400), false);
  assert.equal(jp.isShort({ basis: 'chunk-composition', totalSegments: 100 }, 400), false);
  assert.equal(jp.isShort({ basis: 'segments' }, 400), false);
  assert.equal(key('x', { basis: 'planning', plannedChunks: 1, totalChunks: 4 }, opts), key('x', { basis: 'planning', plannedChunks: 1, totalChunks: 4 }, { early: true }));
});

test('manager applies the setting and can be switched off', () => {
  const jobs = new Map([['s', { priority: 'x' }], ['l', { priority: 'y' }]]);
  const details = { s: { basis: 'segments', totalSegments: 194, completedSegments: 40 }, l: { basis: 'segments', totalSegments: 2246, completedSegments: 1783 } };
  let on = true;
  const manager = jp.createJobPriority({ getJobs: () => jobs, getLanes: () => new Map(), progress: id => details[id], getDb: () => null,
    setTimer: () => null, settings: () => ({ earlyPhasePriority: true, shortVideoPriority: on, shortVideoMaxSegments: 400 }) });
  manager.tick();
  assert.ok(jobs.get('s').priority < jobs.get('l').priority);
  assert.equal(manager.stats.shortMax, 400);
  on = false;
  manager.tick();
  assert.ok(jobs.get('l').priority < jobs.get('s').priority);
  assert.equal(manager.stats.shortMax, 0);
});

test('settings: defaults on with 400, own knob file overrides, bad values ignored', () => {
  const base = Date.now() + 1e7;
  const boost = () => ({ earlyPhasePriority: false });
  assert.deepEqual(settingsModule.schedulingSettings(base, boost, () => { throw new Error('missing'); }),
    { earlyPhasePriority: false, shortVideoPriority: true, shortVideoMaxSegments: 400 });
  assert.deepEqual(settingsModule.schedulingSettings(base + 5000, boost, () => ({ enabled: false, maxSegments: 250 })),
    { earlyPhasePriority: false, shortVideoPriority: false, shortVideoMaxSegments: 250 });
  assert.deepEqual(settingsModule.schedulingSettings(base + 10000, () => { throw new Error('x'); }, () => ({ enabled: 'yes', maxSegments: -3 })),
    { earlyPhasePriority: true, shortVideoPriority: true, shortVideoMaxSegments: 400 });
});
