import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bundlePath = process.env.VF_TEST_BUNDLE;
const source = fs.readFileSync(new URL('../node/custom.mjs', import.meta.url), 'utf8');
const policy = source.slice(source.indexOf('const isSurplus ='), source.indexOf('// Text/vision chains')).replaceAll('export ', '');
const bundle = bundlePath ? fs.readFileSync(bundlePath, 'utf8') : '';
async function simulate(errors, { disabled = false, guard = false } = {}) {
  const begin = bundle.indexOf('const __vfLim=z;for(');
  assert.ok(begin >= 0, 'reviewed native attempt loop');
  const end = bundle.indexOf('if(H.length>0)', begin);
  assert.ok(end > begin && end - begin < 6000);
  const body = bundle.slice(begin, end);
  assert.ok(body.endsWith('}}}'), 'native loop boundary unchanged');
  const calls = [], waits = [];
  const context = {
    modEnabled: () => !disabled,
    customSettings: { surplusAttempts: 9, surplusRetryMinSec: 1, surplusRetryMaxSec: 6 },
    U: { provider: 'surplus', model: 'gpt-5.6-luna' }, z: 3, Y: false, d: 'job', A: {},
    X: {}, u: 'route', a: '', e: [], h: 300000, G: 3, W: 'fallback', I: [], T: false,
    w: null, f: 1000, t: { acquireSlot: fn => fn() },
    gis: async () => { const error = errors[calls.length]; calls.push(error); if (error) throw error; return 'success'; },
    axn: () => false, Rte: () => null, eis() {}, k() {}, Zos() {},
    uBt: () => guard, vos: () => true, nis: () => false, ju: e => Boolean(e?.noRetry),
    rxn: e => ['network', 'timeout'].includes(e.code) || e.detail?.status >= 500 || [408, 425, 429].includes(e.detail?.status),
    rBt: () => true, tis: () => 1000, nBt: async (_, ms) => waits.push(ms),
  };
  vm.createContext(context);
  vm.runInContext(policy + ';globalThis.__vfCustom={llmAttempts,retryDelay,...(typeof shouldStopSurplusRetry==="function"?{shouldStopSurplusRetry}:{})};', context);
  let result, thrown;
  try { result = await vm.runInContext('(async()=>{' + body.slice(0, -1) + '})()', context); }
  catch (error) { thrown = error; }
  return { calls, waits, result, thrown };
}
const error = (status, code) => ({ code: `http_${status}`, provider: 'surplus', detail: { status, body: JSON.stringify({ error: { code } }) } });
test('real native loop retries market 404 once then accepts success', { skip: !bundlePath }, async () => {
  const r = await simulate([error(404, 'minimum_discount_not_met')]);
  assert.equal(r.thrown, undefined);
  assert.equal(r.result, 'success');
  assert.equal(r.calls.length, 2);
  assert.equal(r.waits.length, 1);
  assert.ok(r.waits[0] >= 1000 && r.waits[0] <= 6000);
});
test('real native loop stops at the existing nine-attempt cap', { skip: !bundlePath }, async () => {
  const r = await simulate(Array.from({ length: 12 }, () => error(404, 'no_sellers')));
  assert.equal(r.thrown, undefined);
  assert.equal(r.calls.length, 9);
  assert.equal(r.waits.length, 8);
});
test('real native loop preserves credit/auth/model hard stops', { skip: !bundlePath }, async () => {
  for (const [status, code] of [[402, 'insufficient_credit'], [401, 'invalid_api_key'], [404, 'model_not_found']]) {
    const r = await simulate([error(status, code)]);
    assert.equal(r.thrown, undefined);
    assert.equal(r.calls.length, 1);
    assert.equal(r.waits.length, 0);
  }
});
test('real native abort/noRetry/semantic guards remain authoritative', { skip: !bundlePath }, async () => {
  const aborted = await simulate([{ code: 'aborted' }]);
  assert.equal(aborted.thrown?.code, 'aborted');
  assert.equal(aborted.calls.length, 1);
  for (const r of [await simulate([{ ...error(404, 'no_sellers'), noRetry: true }]), await simulate([error(404, 'no_sellers')], { guard: true })]) {
    assert.equal(r.thrown, undefined);
    assert.equal(r.calls.length, 1);
    assert.equal(r.waits.length, 0);
  }
});
test('disabled mod retains stock market handling', { skip: !bundlePath }, async () => {
  const r = await simulate([error(404, 'no_sellers')], { disabled: true });
  assert.equal(r.thrown, undefined);
  assert.equal(r.calls.length, 1);
  assert.equal(r.waits.length, 0);
});
