import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../node/custom.mjs', import.meta.url), 'utf8');
const begin = source.indexOf('const isSurplus =');
const end = source.indexOf('// Text/vision chains', begin);
function policy(enabled = true) {
  const scope = {
    modEnabled: () => enabled,
    customSettings: { surplusAttempts: 9, surplusRetryMinSec: 1, surplusRetryMaxSec: 6 },
    Math: Object.create(Math),
  };
  vm.createContext(scope);
  vm.runInContext(source.slice(begin, end).replaceAll('export ', ''), scope);
  return scope;
}
const spec = { provider: 'surplus', model: 'gpt-5.6-luna' };
const error = (status, code) => ({ code: `http_${status}`, provider: 'surplus', detail: {
  status, body: JSON.stringify({ error: { type: 'invalid_request_error', code, message: 'Unavailable' } }),
} });
function stop(p, s, e, hard = true, retryable = false) {
  // This is the deployed native predicate when the repair hook is absent.
  return p.shouldStopSurplusRetry ? p.shouldStopSurplusRetry(s, e, hard, retryable) : hard || !retryable;
}
for (const code of ['minimum_discount_not_met', 'no_sellers', 'no_healthy_sellers', 'no_available_sellers']) {
  test(`temporary marketplace 404 ${code} uses remaining bounded retries`, () => {
    assert.equal(stop(policy(), spec, error(404, code)), false);
  });
}
test('truncated native error body still recognizes structured error code', () => {
  const e = error(404, 'minimum_discount_not_met');
  e.detail.body = '{"error":{"type":"invalid_request_error","code":"minimum_discount_not_met","message":"No sellers';
  assert.equal(stop(policy(), spec, e), false);
});
for (const [status, code] of [[404, 'model_not_found'], [402, 'insufficient_credit'], [401, 'invalid_api_key'], [403, 'forbidden'], [400, 'minimum_discount_not_met']]) {
  test(`${status} ${code} remains a hard stop`, () => {
    assert.equal(stop(policy(), spec, error(status, code)), true);
  });
}
test('ordinary 404 containing the code only in its message is not retried', () => {
  const e = error(404, 'model_not_found');
  e.detail.body = JSON.stringify({ error: { message: 'minimum_discount_not_met', code: 'model_not_found' } });
  assert.equal(stop(policy(), spec, e), true);
});
test('different provider and disabled mod retain native behavior', () => {
  assert.equal(stop(policy(), { provider: 'openrouter' }, error(404, 'no_sellers')), true);
  assert.equal(stop(policy(false), spec, error(404, 'no_sellers')), true);
});
test('503/network retry and schema rejection behavior stay native', () => {
  assert.equal(stop(policy(), spec, error(503, 'no_healthy_sellers'), false, true), false);
  assert.equal(stop(policy(), spec, { code: 'network' }, false, true), false);
  assert.equal(stop(policy(), spec, { code: 'response_validation_failed' }, false, false), true);
});
test('attempt cap and configured random 1-6 second window remain intact', () => {
  const p = policy();
  assert.equal(p.llmAttempts(spec, 3), 9);
  p.Math.random = () => 0;
  assert.equal(p.retryDelay(spec, 800, {}), 1000);
  p.Math.random = () => .5;
  assert.equal(p.retryDelay(spec, 800, {}), 3500);
  p.Math.random = () => .9999;
  assert.equal(p.retryDelay(spec, 800, {}), 6000);
  assert.equal(p.retryDelay(spec, 60000, { detail: { retryAfter: '60' } }), 60000);
  assert.equal(p.retryDelay({ provider: 'other' }, 1753, {}), 1753);
});
