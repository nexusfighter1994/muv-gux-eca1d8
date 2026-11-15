const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.VF_CUSTOM_ROOT || __dirname;
function load(enabled = true) {
  const source = fs.readFileSync(path.join(root, 'node/custom.mjs'), 'utf8');
  const start = source.indexOf('export function surplusOutputBudget(');
  if (start < 0) return (_spec, _role, _pipeline, budget) => budget;
  const end = source.indexOf('\n}', start);
  assert(end > start);
  const context = vm.createContext({ modEnabled: () => enabled });
  vm.runInContext(source.slice(start, end + 2).replace('export ', '') + ';globalThis.select=surplusOutputBudget;', context);
  return context.select;
}
const spec = Object.freeze({ provider: 'surplus', model: 'deepseek-v4.1-flash', effort: 'high', modelOverridden: true });
test('DeepSeek high frame/image Vision defaults have room for reasoning and final JSON', () => {
  const select = load();
  for (const role of ['brollSegmentScorerFrames', 'imageScorerCliProxy'])
    assert.equal(select(spec, role, 'vision', 16384), 65536);
});
test('Luna, text, other providers and other efforts are unchanged', () => {
  const select = load();
  for (const alternative of [{ ...spec, model: 'gpt-5.6-luna' }, { ...spec, effort: 'medium' },
    { ...spec, provider: 'openrouter' }, { ...spec, modelOverridden: false }])
    assert.equal(select(alternative, 'brollSegmentScorerFrames', 'vision', 16384), 16384);
  assert.equal(select(spec, 'brollSegmentScorerFrames', 'scripts', 16384), 16384);
});
test('existing larger and explicit nondefault budgets are untouched', () => {
  const select = load();
  for (const value of [8192, 32768, 65536, 131072, null, 0])
    assert.equal(select(spec, 'imageScorerCliProxy', 'vision', value), value);
});
test('author roles and disabled routing retain their native policy', () => {
  assert.equal(load()(spec, 'hyperframesAuthor', 'vision', 65536), 65536);
  assert.equal(load(false)(spec, 'imageScorerCliProxy', 'vision', 16384), 16384);
});
test('repeat application is idempotent and request specifications stay immutable', () => {
  const select = load();
  const result = select(spec, 'brollSegmentScorerFrames', 'vision', 16384);
  assert.equal(select(spec, 'brollSegmentScorerFrames', 'vision', result), result);
  assert.deepEqual(spec, { provider: 'surplus', model: 'deepseek-v4.1-flash', effort: 'high', modelOverridden: true });
});
test('owner status counters prove prepared 64K requests, not completed responses', () => {
  const select = load();
  select(spec, 'brollSegmentScorerFrames', 'vision', 16384);
  select({ ...spec, model: 'gpt-5.6-luna' }, 'brollSegmentScorerFrames', 'vision', 16384);
  assert.equal(select.stats.preparedRequests, 1);
  assert.equal(select.stats.lastRole, 'brollSegmentScorerFrames');
  assert.equal(select.stats.fromTokens, 16384);
  assert.equal(select.stats.toTokens, 65536);
  assert.equal(Object.hasOwn(select.stats, 'messages'), false);
});
