'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const guard = require('../node/render-prerequisite.cjs');
const fixture = require('./fixtures/render-prerequisite-native.json');

function unavailable() {
  return Object.assign(new Error('Render authorization is temporarily unavailable.'), {
    name: 'RenderAuthorizationUnavailableError', code: 'authorization_unavailable',
    retryable: true, retryAt: '2026-11-03T20:00:00Z', referenceId: 'test-reference',
  });
}
function context(error, { enabled = true, patched = true } = {}) {
  const calls = [];
  const c = {
    calls, S$: () => 'regular', Moe: () => false, $oe: [],
    Xir: { b_roll_video: ['b_roll_image', 'safe_visual'] },
    sb: () => false, GBe: () => false, NMa: new Set(), IMa: 2, RMa: 1,
    CMa: (segment, type) => ({ ...segment, type }),
    MMa: async ({ type }) => { calls.push(type); if (type !== 'safe_visual') throw error; return { outputPath: 'placeholder.mp4' }; },
    Vir: x => x, NTe: class extends Error {}, _Ma: new Set(), Gxo: () => false,
    YB: () => [], ais: new Set(['PipelinePausedError', 'PipelineCanceledError', 'PipelineSupersededError']),
    vfs: /^Pipeline(Canceled|Paused|Superseded)Error$/,
  };
  vm.createContext(c);
  vm.runInContext(Object.values(fixture).join('\n'), c);
  if (patched) guard.install(c, { enabled: () => enabled });
  return c;
}
async function dispatch(c) {
  return c.Kir({ jobId: 'original-job', segment: { id: 'original-segment', type: 'b_roll_video', duration_sec: 6.4 } });
}

test('reproduces stock authorization failure becoming a placeholder', async () => {
  const c = context(unavailable(), { patched: false });
  assert.equal((await dispatch(c)).finalType, 'safe_visual');
  assert.ok(c.calls.includes('safe_visual'));
});
test('transient render prerequisite exits native dispatcher before image/placeholder fallback', async () => {
  const error = unavailable(), c = context(error);
  await assert.rejects(dispatch(c), e => e === error && e.pauseRun === true);
  assert.deepEqual(c.calls, ['b_roll_video']);
  assert.equal(error.code, 'authorization_unavailable');
  assert.equal(error.retryAt, '2026-11-03T20:00:00Z');
  assert.equal(error.retryable, true);
  assert.equal(error.referenceId, 'test-reference');
});
test('LLM control catch propagates the original native prerequisite, not all_providers_failed', () => {
  const error = unavailable(), c = context(error);
  assert.equal(c.axn(error), true);
  assert.equal(c.nc(error), true);
  assert.equal(error.pauseRun, true);
  assert.equal(error.noRetry, true);
});
test('structured wrapped native failures are preserved and stopped, with bounded cycle handling', () => {
  const nested = unavailable();
  const wrapper = Object.assign(new Error('All providers failed'), {
    code: 'all_providers_failed', detail: { errorDetails: [{ code: nested.code, message: nested.message }] },
  });
  const c = context(wrapper);
  assert.equal(c.Wxo(wrapper), 'pause_run');
  assert.equal(wrapper.code, 'all_providers_failed');
  const cyclic = new Error('cycle'); cyclic.cause = cyclic;
  assert.equal(guard.isUnavailable(cyclic), false);
});
test('ordinary quality fallbacks remain available and message text cannot trip the guard', async () => {
  for (const error of [new Error('No usable video'), Object.assign(new Error('authorization_unavailable in quoted prompt'), { code: 'bad_json' })]) {
    const c = context(error);
    assert.equal((await dispatch(c)).finalType, 'safe_visual');
    assert.equal(error.pauseRun, undefined);
  }
});
test('cancel, scheduler abort, slot failure, and genuine provider errors keep their native behavior', () => {
  const c = context(new Error('unused'));
  assert.equal(c.axn({ name: 'PipelineCanceledError' }), true);
  assert.equal(c.nc({}, { jobId: 'x', scheduler: { isJobAborted: () => true } }), true);
  assert.equal(c.axn({ slotAcquisitionFailed: true }), true);
  for (const code of ['http_401', 'http_429', 'http_503', 'bad_signature', 'render_permit_denied']) {
    const e = { code, message: 'native failure' };
    assert.equal(c.axn(e), false);
    assert.equal(e.pauseRun, undefined);
  }
});
test('installation is idempotent and the mod toggle restores original fallback behavior', async () => {
  const c = context(unavailable(), { enabled: false });
  const before = c.Wxo;
  guard.install(c);
  assert.equal(c.Wxo, before);
  assert.equal((await dispatch(c)).finalType, 'safe_visual');
});
test('guard has no network, authorization minting, retry or file writes', () => {
  const s = fs.readFileSync(require.resolve('../node/render-prerequisite.cjs'), 'utf8');
  assert.doesNotMatch(s, /\b(fetch|setInterval|setTimeout|requestRenderPermit|writeFile|exec|spawn)\s*\(/);
});
