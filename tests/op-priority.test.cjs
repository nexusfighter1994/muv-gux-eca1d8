'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
delete globalThis.__vfOpPriority;
const op = require('../node/op-priority.cjs');

// The exact callback shape of the native voiceover cut (minified names vary).
const cut = new Function('SJ', 'ee', 'Nt', 'pe', 'Yt', 'return ()=>SJ({source:ee,prepared:!0,targetPath:Nt,startTime:pe.start_time,endTime:pe.end_time,...Yt?{outputFormat:Yt}:{}})')(() => 1, {}, 'x', {}, null);

test('voiceover cuts on the ffmpeg lane run with interactive priority; everything else unchanged', () => {
  const seen = [];
  const run = function (jobId, lane, callback, options) { seen.push(options); return lane; };
  run.__vfHomeDirect = true;
  const wrapped = op.wrapRun(run);
  assert.equal(wrapped.__vfHomeDirect, true, 'markers kept');
  assert.equal(wrapped('j', 'ffmpeg', cut, { operation: 'x' }), 'ffmpeg');
  assert.deepEqual(seen.at(-1), { operation: 'x', interactive: true });
  wrapped('j', 'ffmpeg', () => 'other', { a: 1 });
  assert.deepEqual(seen.at(-1), { a: 1 }, 'other ffmpeg work keeps its job rank');
  wrapped('j', 'render', cut, undefined);
  assert.equal(seen.at(-1), undefined, 'other lanes untouched');
  assert.equal(op.stats.byName['voiceover-cut'], 1);
  assert.equal(op.wrapRun(wrapped), wrapped, 'idempotent');
});

test('install waits for the scheduler, then wraps once', () => {
  let scheduler = null, tick;
  op.installOpPriority(() => scheduler, { schedule: fn => { tick = fn; return { unref() {} }; } });
  scheduler = { run() {} };
  tick();
  assert.equal(scheduler.run.__vfOpPriority, true);
});

test('switched off: no boost, and an inner hot-installed op wrapper cannot recognise the step', () => {
  const seen = [];
  const base = function (jobId, lane, callback, options) { seen.push([String(callback), options]); };
  const inner = op.wrapRun(base, () => true);
  inner.__vfOpPriority = false; inner.__vfOpPriorityInner = true;   // as the hot re-wrap marks it
  let on = false;
  const outer = op.wrapRun(inner, () => on);
  assert.equal(outer.__vfOpPriorityInner, undefined);
  outer('j', 'ffmpeg', cut, { a: 1 });
  assert.deepEqual(seen.at(-1)[1], { a: 1 }, 'off: neither wrapper boosts');
  on = true;
  outer('j', 'ffmpeg', cut, { a: 1 });
  assert.deepEqual(seen.at(-1)[1], { a: 1, interactive: true });
});
