import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {createPodWorker} from '../node/runpod/pod-worker.mjs';
import {createPodHook} from '../node/home-graphics/motion-offload/pod-hook.mjs';

const run = promisify(cp.execFile);
const remote = createRequire(import.meta.url)('../node/home-graphics/remote-active.cjs');
const token = crypto.randomBytes(32).toString('hex');

async function alphaFixture(root) {
  const file = path.join(root, 'fixture.mov');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
    "nullsrc=s=1920x1080:r=24:d=0.125,format=yuva444p10le,geq=lum=100:cb=128:cr=128:a='if(lt(X,W/2),0,512)'",
    '-an', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-threads', '1', '-y', file], {windowsHide: true, timeout: 30000});
  return file;
}

async function setup(render, slots = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-podhook-'));
  const worker = createPodWorker({render, slots, root: path.join(root, 'pod'), token, info: {hyperframes: 't', node: process.version}});
  await fs.mkdir(path.join(root, 'pod'));
  await new Promise(r => worker.server.listen(0, '127.0.0.1', r));
  let released = 0;
  const lease = {endpoint: `http://127.0.0.1:${worker.server.address().port}`, token, id: 'pod-test', release() { released++; }};
  const asset = path.join(root, 'hero.png');
  await fs.writeFile(asset, 'asset');
  const options = {compositionHtml: '<html>x</html>', renderOnlyHtml: '', assets: [{filename: 'hero.png', localPath: asset}], format: 'mov', fps: 24,
    resolution: '1920x1080', workers: 3, quality: 'standard', timeoutMs: 300000, targetPath: path.join(root, 'final.mov'), workDir: root};
  return {root, worker, lease, options, released: () => released, close: async () => { worker.close(); await fs.rm(root, {recursive: true, force: true}); }};
}

test('pod render is fetched, verified like a Home result and published atomically; the remote counter covers the pod phase', async () => {
  let fixture, seen = [];
  const h = await setup(async o => { seen.push(remote.snapshot().total); await fs.copyFile(fixture, o.targetPath); });
  try {
    fixture = await alphaFixture(h.root);
    let nativeCalls = 0;
    const hook = createPodHook(async () => { nativeCalls++; return 'native'; }, {lease: h.lease, kind: 'alpha', permitted: () => true, pollMs: 20, homeShare: 1.5});
    const result = await hook(h.options, {duration: 0.125});
    assert.equal(nativeCalls, 0);
    assert.equal(result.videoPath, h.options.targetPath);
    assert.equal(result.width, 1920);
    assert.ok((await fs.stat(h.options.targetPath)).size > 0);
    const receipt = JSON.parse(await fs.readFile(path.join(h.root, 'artifacts', 'pod-receipt.json'), 'utf8'));
    assert.equal(receipt.pod, 'pod-test');
    assert.ok(seen[0] >= 1, 'render ran while the remote counter was raised');
    assert.equal(remote.snapshot().total, 0);
    assert.deepEqual((await fs.readdir(h.root)).filter(n => n.endsWith('.part')), []);
  } finally { await h.close(); }
});

test('pod failure, refusal or a broken result fall back natively with the full deadline', async () => {
  for (const [name, render, slots] of [
    ['render error', async () => { throw Error('lint failed'); }, 1],
    ['corrupt bytes', async o => fs.writeFile(o.targetPath, 'not a mov'), 1]]) {
    const h = await setup(render, slots);
    try {
      let nativeOptions = null;
      const hook = createPodHook(async o => { nativeOptions = o; return 'native'; }, {lease: h.lease, kind: 'alpha', permitted: () => true, pollMs: 20});
      assert.equal(await hook(h.options, {duration: 0.125}), 'native', name);
      assert.equal(nativeOptions.timeoutMs, 300000, name + ': full deadline');
      assert.equal(remote.snapshot().total, 0);
      await assert.rejects(fs.stat(h.options.targetPath));
    } finally { await h.close(); }
  }
  const h = await setup(async () => {});
  try {
    const hook = createPodHook(async () => 'native', {lease: {...h.lease, endpoint: h.lease.endpoint.replace(/:\d+$/, ':1')}, kind: 'alpha', permitted: () => true, pollMs: 20});
    assert.equal(await hook(h.options, {duration: 0.125}), 'native', 'unreachable pod');
    const superseded = createPodHook(async () => 'native', {lease: h.lease, kind: 'alpha', permitted: () => false});
    await assert.rejects(superseded(h.options, {duration: 0.125}), /superseded/);
  } finally { await h.close(); }
});

test('only RunPod proxy https endpoints (or loopback for tests) are accepted', () => {
  const ok = {endpoint: 'https://abc123xyz-8080.proxy.runpod.net', token};
  assert.ok(createPodHook(async () => {}, {lease: ok, kind: 'opaque'}));
  for (const endpoint of ['http://abc-8080.proxy.runpod.net', 'https://evil.example.com', 'https://abc-8080.proxy.runpod.net.evil.com', 'http://10.0.0.5:8080']) {
    assert.throws(() => createPodHook(async () => {}, {lease: {endpoint, token}, kind: 'alpha'}), /pod lease/, endpoint);
  }
  assert.throws(() => createPodHook(async () => {}, {lease: {...ok, token: 'x'}, kind: 'alpha'}), /pod lease/);
});
