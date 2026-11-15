'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { wrapSurplusRequest, createKeyReader } = require(path.join(__dirname, '../node/surplus-model-keys.cjs'));

const KEY = 'inf_' + 'a'.repeat(32);
function setup(key = KEY) {
  const seen = [];
  const native = args => { seen.push(args.apiKey); return 'ok'; };
  return { seen, wrapped: wrapSurplusRequest(native, { readKey: () => key }) };
}
const call = (model, provider = 'surplus') => ({ url: 'u', apiKey: 'old', payload: { model, messages: [] }, provider });

test('DeepSeek on Surplus uses its own key, every attempt', () => {
  const { seen, wrapped } = setup();
  wrapped(call('deepseek-v4.1-flash')); wrapped(call('deepseek-v4.1-flash')); wrapped(call('surplus/DeepSeek-V4.1-Flash'));
  assert.deepEqual(seen, [KEY, KEY, KEY]);
  assert.equal(wrapped.stats.routed, 3);
});
test('Luna and other providers keep the configured key', () => {
  const { seen, wrapped } = setup();
  wrapped(call('gpt-6-luna')); wrapped(call('deepseek-v4.1-flash', 'openrouter'));
  assert.deepEqual(seen, ['old', 'old']);
});
test('missing or invalid key file falls back to the configured key', () => {
  const { seen, wrapped } = setup(null);
  wrapped(call('deepseek-v4.1-flash'));
  assert.deepEqual(seen, ['old']);
  assert.equal(wrapped.stats.missingKey, 1);
});
test('the original arguments object is not mutated', () => {
  const { wrapped } = setup();
  const args = call('deepseek-v4.1-flash');
  wrapped(args);
  assert.equal(args.apiKey, 'old');
});
test('wrapping is idempotent', () => {
  const { wrapped } = setup();
  assert.equal(wrapSurplusRequest(wrapped), wrapped);
});
test('key reader validates format and caches for 5 s', () => {
  let at = 0, body = '  ' + KEY + '\n', reads = 0;
  const read = () => { reads++; if (body === null) throw Error('missing'); return body; };
  const reader = createKeyReader({ now: () => at, read });
  assert.equal(reader(), KEY);
  body = 'not-a-key'; at = 1000; assert.equal(reader(), KEY);
  at = 6000; assert.equal(reader(), null);
  body = null; at = 12000; assert.equal(reader(), null);
  assert.equal(reads, 3);
});

const { wrapAttempt, withConfiguredKeyRound, wrapChainBuilder, keyScope } = require(path.join(__dirname, '../node/surplus-model-keys.cjs'));

test('the extra DeepSeek leg (surplusKey configured) keeps the configured key for all its attempts', async () => {
  const seen = [];
  const request = wrapSurplusRequest(args => { seen.push(args.apiKey); return 'ok'; }, { readKey: () => KEY });
  const gis = wrapAttempt(async ({ spec }) => { await new Promise(r => setTimeout(r, 1)); return request(call(spec.model)); });
  await gis({ spec: { provider: 'surplus', model: 'deepseek-v4.1-flash' } });
  await gis({ spec: { provider: 'surplus', model: 'deepseek-v4.1-flash', surplusKey: 'configured' } });
  await gis({ spec: { provider: 'surplus', model: 'deepseek-v4.1-flash', surplusKey: 'configured' } });
  await gis({ spec: { provider: 'surplus', model: 'deepseek-v4.1-flash' } });
  assert.deepEqual(seen, [KEY, 'old', 'old', KEY]);
  assert.equal(request.stats.configuredRound, 2);
  assert.equal(keyScope.getStore(), undefined);
});
test('chain: DeepSeek copy on the configured key runs after DeepSeek and before the Luna fallback', () => {
  const ds = { provider: 'surplus', id: 'surplus', model: 'deepseek-v4.1-flash', effort: 'high' };
  const luna = { provider: 'surplus', id: 'surplus', model: 'gpt-5.6-luna', effort: 'medium' };
  const chain = [{ provider: 'cli-proxy', model: 'x' }, ds, luna, { provider: 'openrouter', model: 'y' }];
  const out = withConfiguredKeyRound(chain, { hasKey: () => true });
  assert.deepEqual(out.map(l => `${l.model}${l.surplusKey ? '@' + l.surplusKey : ''}`),
    ['x', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash@configured', 'gpt-5.6-luna', 'y']);
  assert.equal(out[2].effort, 'high');
  assert.equal(withConfiguredKeyRound(out, { hasKey: () => true }), out);
  assert.equal(withConfiguredKeyRound(chain, { hasKey: () => false }), chain);
  assert.equal(withConfiguredKeyRound([luna], { hasKey: () => true }).length, 1);
});
test('chain builder wrapper and request wrapper upgrade from v1 without double wrapping', () => {
  const builder = wrapChainBuilder(chain => chain);
  assert.equal(wrapChainBuilder(builder), builder);
  const native = () => 'ok';
  const v1 = Object.assign(() => 'v1', { __vfSurplusModelKeys: 'surplus-model-keys-v1', original: native });
  assert.equal(wrapSurplusRequest(v1).original, native);
});
