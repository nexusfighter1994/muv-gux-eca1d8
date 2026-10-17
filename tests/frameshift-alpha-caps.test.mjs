import test from 'node:test';
import assert from 'node:assert/strict';
import * as worker from '../node/home-graphics/motion-offload/alpha-worker.mjs';
import {createAlphaHook} from '../node/home-graphics/motion-offload/alpha-hook.mjs';

test('large alpha output does not raise the existing input limits', () => {
  assert.equal(worker.MAX_BODY, 48 * 1024 * 1024);
  assert.equal(worker.MAX_ARTIFACT, 32 * 1024 * 1024);
  assert.equal(worker.MAX_OUTPUT, 128 * 1024 * 1024);
  assert.equal(worker.MAX_RESPONSE, 176 * 1024 * 1024);
  const bytes = Buffer.alloc(33 * 1024 * 1024);
  assert.throws(() => worker.decodeBase64(bytes.toString('base64')));
  assert.equal(worker.decodeBase64(bytes.toString('base64'), worker.MAX_OUTPUT).length, bytes.length);
});

test('old motion health without explicit alpha capability stays native', async () => {
  let calls = 0, posts = 0;
  const hook = createAlphaHook(async o => { calls++; return o.targetPath; }, {
    endpoint: 'http://127.0.0.1:18191', token: 'test-only', contract: 'caps-only',
    permitted: () => true,
    fetchImpl: async (_url, init) => {
      if (init.method === 'POST') posts++;
      return Response.json({version: 1, contract: 'caps-only', slots: 1});
    },
  });
  const value = await hook({compositionHtml: '<div/>', assets: [], fps: 24,
    resolution: '1920x1080', format: 'mov', targetPath: 'no-write.mov',
    workDir: 'no-write', timeoutMs: 1000}, {kind: worker.KIND, duration: 1});
  assert.equal(value, 'no-write.mov');
  assert.equal(calls, 1);
  assert.equal(posts, 0);
});
