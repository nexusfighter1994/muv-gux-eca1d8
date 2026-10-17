import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../backend-evidence/', import.meta.url);
const bundle = fs.readFileSync(new URL('server/dist/index.mjs', root), 'utf8');
function hook(marker) {
  const start = bundle.indexOf(marker);
  assert.ok(start >= 0, marker);
  return bundle.slice(start + marker.length, bundle.indexOf('\n', start));
}

test('pinned-bundle Fish policy retains both original native functions when disabled', () => {
  const code = hook('/* vf-custom:fish-free */');
  const names = [...code.matchAll(/([\w$]+)=__vfCustom\.fishFree/g)].map(match => match[1]);
  assert.equal(names.length, 2);
  for (const enabled of [false, true]) {
    const original = () => 'native', custom = () => 'free';
    const scope = { [names[0]]: original, [names[1]]: original,
      __vfCustom: { modEnabled: id => { assert.equal(id, 'fishFree'); return enabled; },
        fishFreeModel: custom, fishFreeAvailable: custom, report() {} } };
    vm.runInNewContext(code, scope);
    for (const name of names) assert.equal(scope[name], enabled ? custom : original);
  }
});

test('pinned-bundle AI33 flag only unwraps one transcript when enabled', () => {
  const marker = '/* vf-custom:ai33-stt-envelope-v1 */';
  const start = bundle.indexOf(marker) + marker.length;
  const expression = bundle.slice(start, bundle.indexOf(';', start) + 1);
  const name = expression.slice(0, expression.indexOf('='));
  const transcript = { text: 'spoken', words: [{ start: 1, end: 2 }] };
  for (const enabled of [false, true]) {
    const packet = [transcript];
    const scope = { [name]: packet, __vfCustom: { modEnabled: () => enabled } };
    vm.runInNewContext(expression, scope);
    assert.equal(scope[name], enabled ? transcript : packet);
  }
});

test('generated map renderer retains native path when disabled and child recursion guard', () => {
  const source = fs.readFileSync(new URL('render/geomap/index.js', root), 'utf8');
  const begin = source.indexOf('export function render(options)');
  const body = source.slice(begin, source.indexOf('render.isolationVersion', begin)).replace('export ', '');
  for (const enabled of [false, true]) {
    const scope = { process: { env: {} }, modEnabled: () => enabled,
      renderInProcess: () => 'native', isolatedRender: () => 'isolated', activeEngine: () => 'cartograph' };
    const render = vm.runInNewContext(`${body};render`, scope);
    assert.equal(render({}), enabled ? 'isolated' : 'native');
    assert.equal(render({ engine: 'mapbox' }), 'native');
    scope.process.env.VIDFORGE_GEOMAP_ISOLATED_CHILD = '1';
    scope.modEnabled = () => { throw Error('Child cannot read Node boot flags'); };
    assert.equal(render({}), 'native');
  }
});

test('disabled generated Home startup cannot create timers or access native clients', () => {
  vm.runInNewContext(hook('/* vf-custom:independent-home-queue-v5 */'), {
    __vfCustom: { modEnabled: () => false },
    setInterval() { throw Error('Disabled Home started a timer'); },
  });
});

test('generated queue predicate is exactly native no-cap when disabled', () => {
  const match = /AND \$\{(__vfCustom\.modEnabled\('queueLimit'\) \? .*? : "1=1")\}`/.exec(bundle);
  assert.ok(match, 'Missing executable queue gate');
  for (const enabled of [false, true]) {
    const predicate = vm.runInNewContext(match[1], { __vfCustom: { modEnabled: () => enabled, maxActiveVideos: () => 15 } });
    assert.equal(predicate, enabled ? "(SELECT COUNT(*) FROM queue_jobs WHERE status IN ('running', 'pausing')) < 15" : '1=1');
  }
});
