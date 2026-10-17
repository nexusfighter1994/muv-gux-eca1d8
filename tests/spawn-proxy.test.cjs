'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { pathToFileURL } = require('node:url');
const { createSpawnProxy, install, uninstall, nativeShape } = require('../node/spawn-proxy.cjs');

// Native exec (stock qAt, 2026.10.13.7) with the spawn function injected.
class Bfe extends Error { constructor(e, r, { stderr } = {}) { super(`${e} timed out after ${r}ms`); this.code = 'FFMPEG_TIMEOUT'; this.stderr = stderr; } }
function qAt(bmi, publish, e, t, { timeoutMs: r = 12e4, signal: n, onSpawn: i } = {}) {
  return new Promise((a, s) => {
    let l; try { l = bmi(e, t, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (h) { s(h); return; }
    if (l.pid && publish({ pid: l.pid, engine: 'ffmpeg' }), typeof i == 'function') try { i(l); } catch {}
    let c = '', u = '', d = !1, p = () => { d = !0, l.kill('SIGTERM'); };
    n?.aborted ? p() : n?.addEventListener('abort', p, { once: !0 });
    let f = setTimeout(() => { n?.removeEventListener('abort', p), l.kill('SIGKILL'), s(new Bfe(e, r, { stderr: u })); }, r);
    l.stdout?.on('data', h => { c += h; }), l.stderr?.on('data', h => { u += h; });
    l.once('error', h => { clearTimeout(f), n?.removeEventListener('abort', p), s(h); });
    l.once('close', h => { clearTimeout(f), n?.removeEventListener('abort', p), d ? s(Object.assign(new Error(`${e} aborted`), { name: 'AbortError' })) : h === 0 ? a({ stdout: c, stderr: u }) : s(new Error(`${e} exited with code ${h}: ${u.slice(0, 500)}`)); });
  });
}
const settle = p => p.then(v => ({ ok: v }), e => ({ err: { name: e.name, code: e.code, message: e.message } }));

function setup(extra = {}) {
  const published = [];
  const proxy = createSpawnProxy({ unref: false, publish: m => published.push(m), ...extra });
  const viaProxy = (...a) => qAt((f, args, o) => proxy.spawn(f, args, o), () => {}, ...a);
  const viaNative = (...a) => qAt(childProcess.spawn, () => {}, ...a);
  return { proxy, published, viaProxy, viaNative };
}

test('only the exact native exec shape is proxied', () => {
  const stdio = ['ignore', 'pipe', 'pipe'];
  assert.ok(nativeShape('/usr/bin/ffmpeg', ['-version'], { stdio }));
  assert.ok(nativeShape('ffprobe', ['-v', 'error'], { stdio }));
  assert.ok(!nativeShape('/usr/bin/python3', [], { stdio }));
  assert.ok(!nativeShape('ffmpeg', [], { stdio, cwd: '/tmp' }));
  assert.ok(!nativeShape('ffmpeg', [], { stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.ok(!nativeShape('ffmpeg', [], { stdio: 'pipe' }));
});

test('success, failure exit and missing binary behave exactly like native spawn', async () => {
  const { proxy, viaProxy, viaNative } = setup();
  try {
    const [a, b] = [await settle(viaNative('ffmpeg', ['-hide_banner', '-version'])), await settle(viaProxy('ffmpeg', ['-hide_banner', '-version']))];
    assert.ok(a.ok && b.ok);
    assert.equal(b.ok.stdout, a.ok.stdout);
    const missing = path.join(os.tmpdir(), 'vf-no-such-input.mp4');
    const [c, d] = [await settle(viaNative('ffprobe', ['-v', 'error', missing])), await settle(viaProxy('ffprobe', ['-v', 'error', missing]))];
    assert.deepEqual(d, c);
    const ghost = path.join(os.tmpdir(), 'vf-missing-dir', 'ffmpeg');
    const [e, f] = [await settle(viaNative(ghost, ['-version'])), await settle(viaProxy(ghost, ['-version']))];
    assert.equal(f.err.code, e.err.code);
    assert.equal(f.err.code, 'ENOENT');
    // Event sequence for a binary that cannot start: native = error, close (no exit).
    const events = spawnFn => new Promise(resolve => { const c = spawnFn(ghost, ['-v'], { stdio: ['ignore', 'pipe', 'pipe'] }), ev = [];
      for (const n of ['spawn', 'error', 'exit']) c.on(n, () => ev.push(n));
      c.on('close', () => resolve([...ev, 'close'])); });
    assert.deepEqual(await events((...a) => proxy.spawn(...a)), await events(childProcess.spawn));
    assert.equal(proxy.stats.proxied, 4);
    assert.equal(proxy.stats.helperStarts, 1, 'one helper serves all execs');
  } finally { proxy.close(); }
});

test('abort and timeout kill the process like native', async () => {
  const { proxy, viaProxy } = setup();
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:r=5', '-f', 'null', '-'];
    const controller = new AbortController();
    const running = settle(viaProxy('ffmpeg', args, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 400);
    assert.equal((await running).err.name, 'AbortError');
    const timed = await settle(viaProxy('ffmpeg', args, { timeoutMs: 400 }));
    assert.equal(timed.err.code, 'FFMPEG_TIMEOUT');
    // An abort before the helper confirmed the spawn is applied once the pid is known.
    const early = new AbortController(); early.abort();
    assert.equal((await settle(viaProxy('ffmpeg', args, { signal: early.signal }))).err.name, 'AbortError');
  } finally { proxy.close(); }
});

test('spawn accounting is published with the pid in the caller async context', async () => {
  const als = new AsyncLocalStorage();
  const seen = [];
  const proxy = createSpawnProxy({ unref: false, publish: m => seen.push({ ...m, store: als.getStore() }) });
  try {
    await als.run({ job: 'j1' }, () => qAt((f, a, o) => proxy.spawn(f, a, o), () => {}, 'ffmpeg', ['-hide_banner', '-version']));
    assert.equal(seen.length, 1);
    assert.ok(Number.isInteger(seen[0].pid) && seen[0].pid > 0);
    assert.equal(seen[0].engine, 'ffmpeg');
    assert.deepEqual(seen[0].store, { job: 'j1' });
  } finally { proxy.close(); }
});

test('a dead helper fails only its in-flight execs; later execs use native spawn', async () => {
  let t = 0;
  const { proxy, viaProxy } = setup({ now: () => t, retryMs: 1000 });
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:r=5', '-f', 'null', '-'];
  try {
    const inflight = settle(viaProxy('ffmpeg', args, { timeoutMs: 20000 }));
    await new Promise(r => setTimeout(r, 300));
    process.kill(proxy.stats.helperPid, 'SIGKILL');
    const r = await inflight;
    assert.equal(r.err.code, 'ESPAWNHELPER');
    const native = await settle(viaProxy('ffmpeg', ['-hide_banner', '-version']));
    assert.ok(native.ok);
    assert.equal(proxy.stats.native, 1);
    t = 2000;
    assert.ok((await settle(viaProxy('ffmpeg', ['-hide_banner', '-version']))).ok);
    assert.equal(proxy.stats.helperStarts, 2, 'helper restarted after retryMs');
  } finally { proxy.close(); }
});

test('install() reaches ESM `import {spawn}` bindings and uninstall() restores them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-spawn-esm-'));
  const file = path.join(dir, 'probe.mjs');
  fs.writeFileSync(file, "import {spawn} from 'node:child_process';export const current=()=>spawn;");
  const mod = await import(pathToFileURL(file).href);
  const original = mod.current();
  try {
    const proxy = install({ unref: false });
    assert.equal(mod.current().__vfSpawnProxy, proxy);
    assert.equal(globalThis.__vfSpawnProxy, proxy);
    const out = await qAt(mod.current(), () => {}, 'ffmpeg', ['-hide_banner', '-version']);
    assert.match(out.stdout, /ffmpeg version/);
    assert.equal(proxy.stats.proxied, 1);
  } finally {
    uninstall();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(mod.current(), original);
});
