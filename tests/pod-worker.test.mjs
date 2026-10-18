import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPodWorker, validateJob } from '../node/runpod/pod-worker.mjs';

const token = 'a'.repeat(64);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const asset = Buffer.from('png-bytes');
const job = (change = {}) => ({ id: crypto.randomBytes(16).toString('hex'), kind: 'opaque', format: 'mp4', compositionHtml: '<html>x</html>', renderOnlyHtml: '',
  assets: [{ filename: 'hero.png', sha256: sha(asset), data: asset.toString('base64') }], fps: 24, resolution: '1920x1080', workers: 3, quality: 'standard',
  duration: 2.5, timeoutMs: 60000, ...change });

async function harness(render, slots = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-pod-test-'));
  const w = createPodWorker({ render, slots, root, token, info: { hyperframes: '0.7.90', node: process.version } });
  await new Promise(r => w.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${w.server.address().port}`;
  const call = (p, init = {}) => fetch(base + p, { ...init, headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) } });
  return { w, base, call, root, close: async () => { w.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };

test('health, auth and the full async job cycle return the rendered bytes with their sha256', async () => {
  let seen;
  const h = await harness(async o => { seen = o; assert.equal(await fs.readFile(o.assets[0].localPath, 'utf8'), 'png-bytes'); await fs.writeFile(o.targetPath, 'MP4DATA'); });
  try {
    assert.equal((await fetch(h.base + '/health')).status, 401);
    assert.equal((await fetch(h.base + '/health', { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } })).status, 401);
    const health = await (await h.call('/health')).json();
    assert.deepEqual([health.ok, health.slots, health.hyperframes], [true, 1, '0.7.90']);
    const p = job();
    const created = await h.call('/jobs', { method: 'POST', body: JSON.stringify(p) });
    assert.equal(created.status, 202);
    const done = await until(async () => { const s = await (await h.call('/jobs/' + p.id)).json(); return s.state === 'done' && s; });
    assert.equal(done.sha256, sha(Buffer.from('MP4DATA')));
    assert.deepEqual([seen.format, seen.workers, seen.fps, seen.resolution, seen.renderOnlyHtml], ['mp4', 3, 24, '1920x1080', '']);
    const result = await h.call('/jobs/' + p.id + '/result');
    assert.equal(result.headers.get('x-sha256'), done.sha256);
    assert.equal(Buffer.from(await result.arrayBuffer()).toString(), 'MP4DATA');
    assert.equal((await h.call('/jobs/' + p.id, { method: 'DELETE' })).status, 200);
    assert.equal((await h.call('/jobs/' + p.id)).status, 404);
  } finally { await h.close(); }
});

test('render failures and cancellation are reported; busy pods refuse instead of queueing deep', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = await harness(async o => { if (o.compositionHtml.includes('FAIL')) throw Error('lint failed'); await gate; if (o.signal.aborted) throw o.signal.reason; await fs.writeFile(o.targetPath, 'X'); });
  try {
    const bad = job({ compositionHtml: '<html>FAIL</html>' });
    await h.call('/jobs', { method: 'POST', body: JSON.stringify(bad) });
    const failed = await until(async () => { const s = await (await h.call('/jobs/' + bad.id)).json(); return s.state === 'failed' && s; });
    assert.match(failed.error, /lint failed/);
    const a = job(), b = job(), c = job();
    assert.equal((await h.call('/jobs', { method: 'POST', body: JSON.stringify(a) })).status, 202);
    assert.equal((await h.call('/jobs', { method: 'POST', body: JSON.stringify(b) })).status, 202, 'one waits behind the running one');
    assert.equal((await h.call('/jobs', { method: 'POST', body: JSON.stringify(c) })).status, 503, 'busy');
    assert.equal((await h.call('/jobs', { method: 'POST', body: JSON.stringify(a) })).status, 409, 'duplicate id');
    assert.equal((await h.call('/jobs/' + a.id, { method: 'DELETE' })).status, 200);
    release();
    const second = await until(async () => { const s = await (await h.call('/jobs/' + b.id)).json(); return s.state === 'done' && s; });
    assert.equal(second.state, 'done');
    assert.equal((await h.call('/jobs/' + b.id + '/result')).status, 200);
  } finally { release(); await h.close(); }
});

test('payload validation fails closed (400)', async () => {
  for (const change of [{ id: 'x' }, { kind: 'alpha', format: 'mp4' }, { fps: 30 }, { workers: 4 }, { duration: 16 }, { timeoutMs: 600001 }, { quality: 'max' },
    { assets: [{ filename: '../x', sha256: sha(asset), data: asset.toString('base64') }] }, { assets: [{ filename: 'a.png', sha256: '0'.repeat(64), data: asset.toString('base64') }] }]) {
    assert.throws(() => validateJob(job(change)), error => error.status === 400, JSON.stringify(change));
  }
  assert.equal(validateJob(job({ kind: 'alpha', format: 'mov' })).format, 'mov');
  const h = await harness(async () => {});
  try { assert.equal((await h.call('/jobs', { method: 'POST', body: JSON.stringify(job({ fps: 30 })) })).status, 400); } finally { await h.close(); }
  assert.throws(() => createPodWorker({ render: async () => {}, token: 'short' }), /64 hex/);
});
