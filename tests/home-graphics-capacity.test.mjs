import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createMotionHook} from '../node/home-graphics/motion-offload/hook.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const remote = require('../node/home-graphics/remote-active.cjs');
const {createOpaqueBridge, wrapRenderLane, wrapFrameshiftCap} = require('../node/home-graphics/motion-offload/opaque-overflow.cjs');
const hookUrl = pathToFileURL(path.join(here, '../node/home-graphics/motion-offload/hook.mjs')).href;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-capacity-'));
const fixture = path.join(dir, 'fixture.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=24', '-t', '1', '-c:v', 'libx264',
  '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-video_track_timescale', '12288', fixture], {timeout: 30000, windowsHide: true});
const bytes = await fs.readFile(fixture);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
test.after(() => fs.rm(dir, {recursive: true, force: true}));

// Fake Home PC: records what the server sends and what the counter saw meanwhile.
function home({fail = null, delay = 0} = {}) {
  const seen = {payloads: [], activeDuringRender: [], deletes: 0};
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/motion/health') return new Response('{}', {status: fail === 'offline' ? 503 : 200});
    if (init.method === 'DELETE') { seen.deletes++; return Response.json({terminated: true}); }
    const p = JSON.parse(init.body);
    seen.payloads.push(p);
    seen.activeDuringRender.push(remote.snapshot().total);
    if (delay) await new Promise((resolve, reject) => { const t = setTimeout(resolve, delay); init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); }); });
    if (fail === 'busy') return new Response('{"error":"motion busy"}', {status: 500});
    return Response.json({version: 1, id: p.id, contract: p.contract, backend: 'd3d11/nvidia', sha256: sha, data: bytes.toString('base64')});
  };
  return {seen, fetchImpl};
}
const config = fetchImpl => ({endpoint: 'http://127.0.0.1:18191', token: 't', contract: 'c', permitted: () => true, fetchImpl,
  ffprobe: 'ffprobe', ffmpeg: 'ffmpeg', nativeReserveRatio: 0.5, healthTimeoutMs: 5000});
// Production configuration (server-integration.mjs / hot bridge).
const production = fetchImpl => ({...config(fetchImpl), nativeReserveRatio: 0.3, freshNativeBudget: true});
const options = name => ({compositionHtml: '<html>orig</html>', renderOnlyHtml: '', assets: [], fps: 24, resolution: '1920x1080',
  workers: 3, quality: 'high', workDir: dir, targetPath: path.join(dir, name + '.mp4'), timeoutMs: 600000});

test('source workers 3 render on the one Home slot with 3 capture workers; counter covers exactly the remote phase', async () => {
  const {seen, fetchImpl} = home();
  let native = 0;
  const result = await createMotionHook(async () => { native++; }, config(fetchImpl))(options('w3'), {duration: 1});
  assert.equal(native, 0);
  assert.equal(seen.payloads[0].workers, 3);
  assert.equal(seen.payloads[0].compositionHtml, '<html>orig</html>');
  assert.deepEqual(seen.activeDuringRender, [1]);
  assert.equal(remote.snapshot().total, 0);
  assert.equal(result.videoPath, path.join(dir, 'w3.mp4'));
});

test('Home busy/offline: native keeps original workers, counter already released, ample budget', async () => {
  for (const fail of ['busy', 'offline']) {
    const {fetchImpl} = home({fail});
    let received;
    await createMotionHook(async o => { received = {...o, activeAtFallback: remote.snapshot().total}; return {native: true}; },
      config(fetchImpl))(options(fail), {duration: 1});
    assert.equal(received.workers, 3);
    assert.equal(received.activeAtFallback, 0);
    assert.ok(received.timeoutMs > 590000, fail + ' fallback must keep nearly the full deadline');
  }
});

test('hung Home render times out after half the budget and leaves half for the server', async () => {
  const {fetchImpl} = home({delay: 5000});
  let received;
  const started = Date.now();
  await createMotionHook(async o => { received = o; return {native: true}; }, config(fetchImpl))({...options('hung'), timeoutMs: 2000}, {duration: 1});
  assert.ok(Date.now() - started < 1800);
  assert.ok(received.timeoutMs >= 900 && received.timeoutMs <= 1100, String(received.timeoutMs));
  assert.equal(remote.snapshot().total, 0);
});

test('production config: hung Home gets 70%, server fallback still gets the FULL original deadline', async () => {
  const {fetchImpl} = home({delay: 5000});
  let received;
  const started = Date.now();
  await createMotionHook(async o => { received = o; return {native: true}; }, production(fetchImpl))({...options('fresh'), timeoutMs: 2000}, {duration: 1});
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1300 && elapsed < 1900, String(elapsed));
  assert.equal(received.timeoutMs, 2000);
  assert.equal(received.workers, 3);
  assert.equal(remote.snapshot().total, 0);
});

test('production config: a finished Home render is kept when receiving it outlasts the Home share', async () => {
  let deletes = 0, native = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/motion/health') return new Response('{}', {status: 200});
    if (init.method === 'DELETE') { deletes++; return Response.json({terminated: true}); }
    const p = JSON.parse(init.body);
    const receipt = JSON.stringify({version: 1, id: p.id, contract: p.contract, backend: 'd3d11/nvidia', sha256: sha, data: bytes.toString('base64')});
    await new Promise(r => setTimeout(r, 300));
    return new Response(new ReadableStream({start(c) {
      const t = setTimeout(() => { c.enqueue(new TextEncoder().encode(receipt)); c.close(); }, 8500);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); c.error(init.signal.reason); }, {once: true});
    }}), {status: 200});
  };
  const result = await createMotionHook(async () => { native++; return {native: true}; }, production(fetchImpl))({...options('slow-body'), timeoutMs: 12000}, {duration: 1});
  assert.equal(result.videoPath, path.join(dir, 'slow-body.mp4'));
  assert.equal(native, 0);
  assert.equal(deletes, 0);
  assert.equal(remote.snapshot().total, 0);
});

test('a lost Home (cancel unconfirmed) pauses offers for QUARANTINE_MS only, then Home is used again', async () => {
  const hookModule = await import(hookUrl + '?quarantine-test');
  let lost = true, posts = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/motion/health') return new Response('{}', {status: 200});
    if (init.method === 'DELETE') { if (lost) throw Error('fetch failed'); return Response.json({terminated: true}); }
    posts++;
    if (lost) throw Error('fetch failed');
    const p = JSON.parse(init.body);
    return Response.json({version: 1, id: p.id, contract: p.contract, backend: 'd3d11/nvidia', sha256: sha, data: bytes.toString('base64')});
  };
  const realNow = Date.now;
  try {
    let native = 0;
    const hook = hookModule.createMotionHook(async () => { native++; return {native: true}; }, {...config(fetchImpl), contract: 'q'});
    await hook(options('q1'), {duration: 1});
    assert.equal(native, 1); assert.equal(posts, 1);
    lost = false;
    await hook(options('q2'), {duration: 1});
    assert.equal(native, 2, 'quarantined: server renders'); assert.equal(posts, 1, 'no upload while quarantined');
    const base = realNow();
    Date.now = () => base + hookModule.QUARANTINE_MS + 1;
    const result = await hook(options('q3'), {duration: 1});
    assert.equal(posts, 2); assert.equal(result.videoPath, path.join(dir, 'q3.mp4'), 'Home used again after quarantine');
  } finally { Date.now = realNow; }
});

test('unsupported shapes never upload', async () => {
  for (const [o, duration] of [[{...options('w4'), workers: 4}, 1], [options('long'), 15.5], [options('none'), undefined]]) {
    const {seen, fetchImpl} = home();
    let native = 0;
    await createMotionHook(async () => { native++; }, config(fetchImpl))(o, {duration});
    assert.equal(native, 1);
    assert.equal(seen.payloads.length, 0);
  }
});

test('lane and frameshift cap grow by one only while a Home render is active', () => {
  const lane = wrapRenderLane(name => ({render: 5, ffmpeg: 14})[name]);
  const cap = wrapFrameshiftCap((e, t, r) => (e === 'render' && r === 'frameshift' ? Math.min(t, 2) : t), () => 2);
  assert.equal(lane('render'), 5);
  assert.equal(cap('render', 5, 'frameshift'), 2);
  const end = remote.begin('frameshift');
  assert.equal(lane('render'), 6);
  assert.equal(lane('ffmpeg'), 14);
  assert.equal(cap('render', lane('render'), 'frameshift'), 3);
  assert.equal(cap('render', 6, 'remotion'), 6);
  end(); end();
  assert.equal(lane('render'), 5);
  assert.equal(cap('render', 5, 'frameshift'), 2);
});

test('hot bridge: shared provider adopted once; renders already waiting use Home; guards keep native', async () => {
  const als = new AsyncLocalStorage();
  const lease = {resourceKey: 'frameshift', released: false, parked: false, signal: new AbortController().signal};
  const scope = {jobId: 'job', lanes: new Set(['render']), leases: new Map([['render', lease]])};
  const {seen, fetchImpl} = home();
  const cfg = {...config(fetchImpl), getSettings: () => ({homeMotion: true}), getToken: () => 't'};
  let licensed = 'job';
  const bridge = createOpaqueBridge({RU: () => licensed, getStore: () => als.getStore(), mF: () => 'render', jp: new Map([['job', {checkAbort() {}}]]),
    Xl: () => null, isJobAborted: () => false, getConfig: () => cfg, loadHook: () => import(hookUrl + '?bridge-test')});
  let nativeCalls = 0;
  const provider = {render: async function () { assert.equal(this, provider); nativeCalls++; return {native: true}; }};
  const html = '<!doctype html><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="1920">x</div>';
  // A render captured BEFORE adoption, like the ~444 waiters: it reads provider.render only when its slot is granted.
  let grant;
  const waiting = new Promise(resolve => { grant = resolve; }).then(() => als.run(scope, () =>
    provider.render.bind(provider)({...options('waiting'), compositionHtml: html})));
  // Shape of native lUn: run under the lease, the old route hands workers 3 to provider.render.
  const lUn = async ({frameshiftImpl, outPath}) => als.run(scope, () => frameshiftImpl.render.bind(frameshiftImpl)({...options('x'), compositionHtml: html, targetPath: outPath}));
  const wrapped = bridge.wrapRenderer(lUn);
  const args = {frameshiftImpl: provider, jobId: 'job', durationSec: 1};
  await wrapped({...args, outPath: path.join(dir, 'bridge.mp4')});
  await wrapped({...args, outPath: path.join(dir, 'bridge1.mp4')});
  assert.equal(bridge.stats.providers, 1);
  grant(); await waiting;
  assert.equal(nativeCalls, 0);
  assert.equal(seen.payloads.length, 3);
  assert.equal(seen.payloads[0].duration, 1);
  assert.equal(bridge.stats.home, 3);
  licensed = 'other';
  await wrapped({...args, outPath: path.join(dir, 'bridge2.mp4')});
  assert.equal(nativeCalls, 1, 'foreign license stays native');
  licensed = 'job';
  for (const extra of [{workers: 1}, {format: 'mov'}, {compositionHtml: '<div>no main</div>'}]) {
    await als.run(scope, () => provider.render({...options('g'), compositionHtml: html, ...extra}));
  }
  assert.equal(nativeCalls, 4);
  assert.equal(seen.payloads.length, 3);
});

test('probe: while the route reports Home can take one more, ONE extra frameshift render is admitted (cap 4)', () => {
  const lane = wrapRenderLane(name => ({render: 5, ffmpeg: 14})[name]);
  const cap = wrapFrameshiftCap((e, t, r) => (e === 'render' && r === 'frameshift' ? Math.min(t, 2) : t), () => 2);
  let offer = true;
  remote.setOfferable(() => offer);
  try {
    assert.equal(cap('render', lane('render'), 'frameshift'), 3, 'one probe slot beyond the native limit');
    assert.equal(cap('render', lane('render'), 'remotion'), 6, 'only frameshift gets the probe; the lane grows with it');
    const ends = [remote.begin('frameshift'), remote.begin('frameshift'), remote.begin('frameshift')];
    assert.equal(cap('render', lane('render'), 'frameshift'), 6, '3 remote + probe');
    ends.push(remote.begin('frameshift'));
    assert.equal(cap('render', lane('render'), 'frameshift'), 6, 'extra capacity never exceeds 4');
    offer = false;
    assert.equal(cap('render', lane('render'), 'frameshift'), 6);
    ends.forEach(end => end());
    assert.equal(cap('render', lane('render'), 'frameshift'), 2, 'no probe while Home cannot take one');
    remote.setOfferable(() => { throw Error('closed'); });
    assert.equal(cap('render', lane('render'), 'frameshift'), 2, 'a failing probe check admits nothing extra');
  } finally { remote.setOfferable(null); }
  assert.equal(cap('render', lane('render'), 'frameshift'), 2);
});

test('remote renders lower one frameshift RAM allocation each (newest first) and restore it on end', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, '__vfRamAllocations');
  const table = new Map([
    [1, {laneKey: 'render', resourceKey: 'frameshift', estimateMb: 3852, grantedAtMs: 100}],
    [2, {laneKey: 'render', resourceKey: 'frameshift', estimateMb: 3852, grantedAtMs: 300}],
    [3, {laneKey: 'ffmpeg', resourceKey: 'ffmpeg', estimateMb: 1191, grantedAtMs: 400}],
    [4, {laneKey: 'render', resourceKey: 'remotion', estimateMb: 2000, grantedAtMs: 500}]]);
  Object.defineProperty(globalThis, '__vfRamAllocations', {configurable: true, get: () => table});
  try {
    const sum = () => [...table.values()].reduce((n, e) => n + e.estimateMb, 0);
    const before = sum();
    const first = remote.begin('frameshift');
    assert.equal(table.get(2).estimateMb, remote.REMOTE_MB, 'newest frameshift allocation lowered');
    assert.equal(table.get(1).estimateMb, 3852);
    const second = remote.begin('frameshift');
    assert.equal(table.get(1).estimateMb, remote.REMOTE_MB);
    const third = remote.begin('frameshift');
    assert.equal(sum(), before - 2 * (3852 - remote.REMOTE_MB), 'no third frameshift entry to lower; ffmpeg/remotion untouched');
    assert.equal(remote.snapshot().loweredMb, 2 * (3852 - remote.REMOTE_MB));
    first(); first();
    assert.equal(table.get(2).estimateMb, 3852, 'restored once on end (idempotent)');
    table.delete(1);
    second();
    third();
    assert.equal(sum(), before - 3852, 'a lease that finished first is simply gone');
    assert.equal(remote.snapshot().loweredMb, 0);
    const other = remote.begin('map');
    assert.equal(table.get(2).estimateMb, 3852, 'other resources never touch frameshift RAM');
    other();
  } finally {
    if (saved) Object.defineProperty(globalThis, '__vfRamAllocations', saved); else delete globalThis.__vfRamAllocations;
  }
  const end = remote.begin('frameshift');
  end();
});
