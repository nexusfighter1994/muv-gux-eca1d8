// The opaque Home motion hook with the busy retry: instant 503s are asked again with a new id, the cancel names the
// attempt in flight, and a real failure still falls back to the server render exactly once.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMotionHook } from './hook.mjs';
import { createAlphaHook } from './alpha-hook.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-busy-hook-'));
const calls = { post: [], del: [], native: 0 };
const script = [503, 503, 500];
const fetchImpl = async (url, init = {}) => {
  const p = new URL(url).pathname;
  if (p === '/motion/health') return { ok: true, status: 200 };
  if (p === '/motion/render') {
    const body = JSON.parse(init.body);
    calls.post.push(body);
    const status = script[Math.min(calls.post.length - 1, script.length - 1)];
    return { ok: false, status, arrayBuffer: async () => new ArrayBuffer(0) };
  }
  if (init.method === 'DELETE') { calls.del.push(p.split('/').pop()); return { ok: true, status: 200, json: async () => ({ terminated: true }) }; }
  throw new Error('unexpected ' + p);
};
const hook = createMotionHook(async options => { calls.native += 1; return { native: true, timeoutMs: options.timeoutMs }; }, {
  endpoint: 'http://127.0.0.1:18191', token: 't', contract: 'c', permitted: async () => true, ffprobe: 'ffprobe', ffmpeg: 'ffmpeg',
  fetchImpl, freshNativeBudget: true, homeShare: 2, nativeReserveRatio: 0.3 });
const t0 = Date.now();
const result = await hook({ targetPath: path.join(dir, 'out.mp4'), workDir: dir, compositionHtml: '<html></html>', assets: [], fps: 24,
  resolution: '1920x1080', workers: 1, timeoutMs: 600000 }, { duration: 5 });
const ids = calls.post.map(b => b.id);
assert.strictEqual(calls.post.length, 3, 'two instant 503s are asked again, the 500 is final');
assert.strictEqual(new Set(ids).size, 3, 'every attempt has its own id');
assert.ok(ids.every(id => /^[a-f0-9]{32}$/.test(id)));
assert.deepStrictEqual(calls.del, [ids[2]], 'the cancel names the last attempt');
assert.deepStrictEqual([calls.native, result.native, result.timeoutMs], [1, true, 600000], 'one server fallback with a fresh budget');
assert.ok(Date.now() - t0 >= 4900, 'waited twice');
assert.ok(calls.post[2].timeoutMs < calls.post[0].timeoutMs, 'the Home deadline keeps running');
assert.ok(globalThis.__vfMotionBusyRetry.busy >= 2 && globalThis.__vfMotionBusyRetry.retries >= 2);
assert.strictEqual(typeof createAlphaHook, 'function');
fs.rmSync(dir, { recursive: true, force: true });
console.log('busy-retry hook test ok', JSON.stringify(globalThis.__vfMotionBusyRetry));
