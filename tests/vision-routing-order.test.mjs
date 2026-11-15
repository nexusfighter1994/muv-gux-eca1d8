import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../node/custom.mjs', import.meta.url), 'utf8');
const begin = source.indexOf('// Text/vision chains');
const end = source.indexOf('// The Surplus market check', begin);
assert.ok(begin > 0 && end > begin);
const general = () => ({
  routingOrder: { vision: ['wellflow', 'surplus', 'cliProxy', 'openrouter'] },
  routingModels: { vision: { wellflow: { model: 'gpt-5.6-luna', effort: 'medium' }, surplus: { model: 'gpt-5.6-luna' } } },
});
const cli = { provider: 'cli-proxy', id: 'cliProxy', model: 'gpt-6-luna', effort: 'high' };
const surplus = { provider: 'surplus', id: 'surplus', model: 'gpt-5.6-luna', modelOverridden: true };
const wellflow = { provider: 'wellflow', id: 'wellflow', model: 'gpt-5.6-luna', effort: 'medium', modelOverridden: true };
const router = { provider: 'openrouter', id: 'openrouter', model: 'google/gemini-3-flash-preview' };
function policy(settings = general(), enabled = true) {
  const scope = { modEnabled: () => enabled, isSurplus: s => s?.provider === 'surplus',
    surplusModelKeys: { withConfiguredKeyRound: chain => chain },
    customSettings: { surplusFirst: true, surplusInsertEfforts: ['low', 'medium', 'high'] },
    settingsDb: { prepare: () => ({ get: () => ({ value_json: JSON.stringify(settings) }) }) },
  };
  vm.createContext(scope);
  vm.runInContext(source.slice(begin, end).replaceAll('export ', ''), scope);
  return scope;
}
const plain = value => JSON.parse(JSON.stringify(value));
const ids = value => Array.from(value, leg => leg.id);

test('explicit Vision order wins over Surplus-first without mutating native legs', () => {
  const chain = Object.freeze([wellflow, surplus, cli, router].map(Object.freeze));
  const actual = policy().surplusFirst(chain, 'visionCheck', false, 'vision');
  assert.deepEqual(ids(actual), ['wellflow', 'surplus', 'cliProxy', 'openrouter']);
  assert.deepEqual(plain(actual), plain(chain));
});
for (const route of ['imageScorerCliProxy', 'brollSegmentScorerFrames']) {
  test(`${route} gets configured Wellflow before existing Surplus fallbacks`, () => {
    const actual = policy().surplusFirst([cli, router], route, false, 'vision');
    assert.deepEqual(ids(actual), ['wellflow', 'surplus', 'surplus', 'surplus', 'cliProxy', 'openrouter']);
    assert.equal(actual[0].model, 'gpt-5.6-luna');
    assert.equal(actual[0].effort, 'medium');
    assert.equal(actual[0].modelOverridden, true);
    assert.deepEqual(Array.from(actual.slice(1, 4), leg => leg.effort), ['low', 'medium', 'high']);
    assert.equal(actual.at(-1), router);
  });
}
test('changing saved Vision order changes effective priority, no hardcoded Wellflow-first', () => {
  const config = general();
  config.routingOrder.vision = ['cliProxy', 'surplus', 'wellflow', 'openrouter'];
  assert.deepEqual(ids(policy(config).surplusFirst([wellflow, cli, surplus, router], 'visionCheck', false, 'vision')),
    ['cliProxy', 'surplus', 'wellflow', 'openrouter']);
});
test('scripts and packaging retain their existing Surplus-first behavior', () => {
  for (const pipeline of ['scripts', 'packaging']) {
    assert.deepEqual(ids(policy().surplusFirst([cli, surplus, router], 'writer', false, pipeline)), ['surplus', 'cliProxy', 'openrouter']);
  }
});
test('native video and special model routes remain unchanged', () => {
  const chain = [cli, router];
  assert.equal(policy().surplusFirst(chain, 'brollSegmentScorerFrames', true, 'vision'), chain);
  for (const route of ['brollSegmentScorer', 'brollSegmentScorerAntigravity', 'imageScorer', 'assetPartLocator', 'thumbnailBlueprintAnalyzer', 'thumbnailValidator']) {
    assert.equal(policy().surplusFirst(chain, route, false, 'vision'), chain);
  }
});
test('missing explicit Wellflow model or order never invents a paid provider leg', () => {
  for (const config of [{}, { routingOrder: general().routingOrder }, { routingModels: general().routingModels }]) {
    assert.ok(!ids(policy(config).surplusFirst([cli, router], 'imageScorerCliProxy', false, 'vision')).includes('wellflow'));
  }
});
test('disabled routing mod remains native', () => {
  const chain = [wellflow, surplus, cli];
  assert.equal(policy(general(), false).surplusFirst(chain, 'visionCheck', false, 'vision'), chain);
});
test('Wellflow without explicit effort retains its native medium default', () => {
  const config = general();
  delete config.routingModels.vision.wellflow.effort;
  const actual = policy(config).surplusFirst([cli, router], 'imageScorerCliProxy', false, 'vision');
  assert.equal(actual[0].effort, 'medium');
});
for (const pipeline of ['scripts', 'packaging']) {
  test(`${pipeline} follows the user order instead of forcing Surplus first`, () => {
    const config = general();
    config.routingOrder[pipeline] = ['cliProxy', 'wellflow', 'surplus', 'openrouter'];
    const actual = policy(config).surplusFirst([cli, wellflow, surplus, router], 'writer', false, pipeline);
    assert.deepEqual(ids(actual), ['cliProxy', 'wellflow', 'surplus', 'openrouter']);
  });
}
