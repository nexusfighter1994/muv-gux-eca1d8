import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createWorkerClient } from '../node/pc-boost-api.mjs';

function coldHealth(workers) {
  const text = fs.readFileSync(new URL('../node/pc-boost-api.mjs', import.meta.url), 'utf8');
  const start = text.indexOf('const getHealth = async () => {');
  const end = text.indexOf('const reconcile =', start);
  assert.ok(start > 0 && end > start);
  return new Function('workers', 'let healthPromise,healthCached,healthTime=0;'
    + text.slice(start, end) + ';return getHealth;')(workers);
}

function response() {
  return new Response(JSON.stringify({ ready: true, protocolVersion: 2, cpuCapacity: 16,
    gpuCapacity: 4, gpuAvailable: true }), { headers: { 'content-type': 'application/json' } });
}

test('a slow healthy tunnel stays reachable on the actual cold-cache UI path', async () => {
  const client = createWorkerClient({ readToken: () => 'isolated-fixture-token',
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response()), 1200);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('timeout')); }, { once: true });
    }),
  });
  const result = await coldHealth(client)();
  assert.equal(result.ffmpeg.reachable, true);
  assert.equal(result.ffmpeg.ready, true);
  assert.equal(result.siglip.reachable, true);
});

test('an actually offline worker is still shown offline', async () => {
  const client = createWorkerClient({ readToken: () => 'isolated-fixture-token',
    fetchImpl: async () => { throw new Error('connection refused'); } });
  const result = await coldHealth(client)();
  assert.equal(result.ffmpeg.reachable, false);
  assert.equal(result.ffmpeg.ready, false);
  assert.equal(result.ffmpeg.reason, 'offline');
});

test('authorization failures are never turned into a healthy connection', async () => {
  const client = createWorkerClient({ readToken: () => 'isolated-fixture-token',
    fetchImpl: async () => new Response('', { status: 401 }) });
  const result = await coldHealth(client)();
  assert.equal(result.ffmpeg.ready, false);
  assert.equal(result.ffmpeg.reason, 'unauthorized');
});

test('Custom uses the current GPU-decode status asset instead of the stale cached version', () => {
  // The Custom page lives in custom-page.mjs since the page split.
  const text = fs.readFileSync(new URL('../node/custom-page.mjs', import.meta.url), 'utf8');
  assert.match(text, /pc-boost-settings-20261002\.js\?v=motion-cpu-20261017e/);
  assert.doesNotMatch(text, /pc-boost-settings-20261002\.js\?v=connection-status-20261014a/);
});
