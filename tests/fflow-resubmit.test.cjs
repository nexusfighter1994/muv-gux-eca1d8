'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResubmitter } = require('../node/fflow-resubmit.cjs');

function fakeFflow(failures) {
  const jobs = new Map(); let n = 0; const posts = [];
  const request = async (path, options = {}) => {
    if ((options.method || 'GET') === 'POST') {
      const id = 'job' + (++n); posts.push({ path, body: options.body });
      jobs.set(id, failures.shift() ?? null);
      return { data: { job_id: id, status: 'queued' } };
    }
    const id = decodeURIComponent(/^\/v1\/jobs\/([^/?]+)/.exec(path)[1]);
    const err = jobs.get(id);
    return err ? { data: { job_id: id, status: 'failed', error: { code: 'RENDER', message: err } } }
      : { data: { job_id: id, status: 'completed', result: { download_url: 'http://fflow/files/' + id } } };
  };
  return { request, posts };
}
const POST = ['/v1/render', { method: 'POST', body: { composition: { output: { filename: 'vfhome-x.mp4' } }, wait_for_results: false } }];
const opts = { sleep: async () => {} };

test('transient Home-fallback failure is resubmitted; caller keeps its job id and gets the new result', async () => {
  const f = fakeFflow(['Unexpected error: Native Home fallback POST retry exhausted']);
  const request = createResubmitter(f.request, opts);
  const { data: { job_id } } = await request(...POST);
  const first = await request(`/v1/jobs/${job_id}?wait=20`);
  assert.equal(first.data.status, 'queued');
  assert.equal(first.data.job_id, job_id);
  const second = await request(`/v1/jobs/${job_id}`);
  assert.equal(second.data.status, 'completed');
  assert.equal(second.data.job_id, job_id);
  assert.equal(second.data.result.download_url, 'http://fflow/files/job2');
  assert.deepEqual(f.posts[0], f.posts[1], 'identical request resubmitted');
  assert.equal(request.stats.resubmits, 1);
  assert.equal(request.stats.recovered, 1);
});

test('at most 3 resubmits, then the original failure surfaces', async () => {
  const msg = 'Native Home fallback admission timed out';
  const f = fakeFflow([msg, msg, msg, msg, msg]);
  const request = createResubmitter(f.request, opts);
  const { data: { job_id } } = await request(...POST);
  let r;
  for (let i = 0; i < 5; i++) r = await request(`/v1/jobs/${job_id}`);
  assert.equal(r.data.status, 'failed');
  assert.equal(f.posts.length, 4);
  assert.equal(request.stats.resubmits, 3);
});

test('other failures and untracked jobs are untouched', async () => {
  const f = fakeFflow(['ffmpeg exited with code 1']);
  const request = createResubmitter(f.request, opts);
  const { data: { job_id } } = await request(...POST);
  assert.equal((await request(`/v1/jobs/${job_id}`)).data.status, 'failed');
  assert.equal(f.posts.length, 1);
  const g = fakeFflow([]);
  const other = createResubmitter(async () => ({ data: { status: 'failed', error: 'Native Home fallback POST retry exhausted' } }), opts);
  assert.equal((await other('/v1/jobs/unknown')).data.status, 'failed', 'no stored submission, no resubmit');
});

test('synchronous requests (no wait_for_results:false) are never tracked; wrapper is idempotent', async () => {
  const f = fakeFflow([]);
  const request = createResubmitter(f.request, opts);
  await request('/v1/probe', { method: 'POST', body: { url: 'x' } });
  assert.equal(request.stats.tracked, 0);
  assert.equal(createResubmitter(request, opts), request);
});
