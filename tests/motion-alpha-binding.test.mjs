import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import * as binding from '../node/home-graphics/motion-offload/binding.mjs';

const KIND = 'frameshift-alpha-v1';
const html = (duration = '3.29') => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>body{background:transparent}</style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="1920" data-height="1080">
  </div><script>window.__timelines={main:{}};</script>
</body></html>`;

function fixture() {
  const als = new AsyncLocalStorage();
  const controller = new AbortController();
  const lease = {jobId: 'job', lane: 'render', resourceKey: 'frameshift',
    released: false, parked: false, signal: controller.signal};
  const scope = {jobId: 'job', lanes: new Set(['render']), leases: new Map([['render', lease]])};
  const state = {licensed: 'job', cancelled: false, checks: 0, native: [], requests: []};
  const context = {kind: KIND, jobId: 'job', licensedJobId: 'job',
    getLicensedJobId: () => state.licensed, getScope: () => als.getStore(), lane: 'render',
    checkAbort() { state.checks++; }, isAborted: () => state.cancelled, outerSignal: controller.signal};
  const options = {compositionHtml: html(), assets: [], fps: 24, resolution: '1920x1080',
    format: 'mov', targetPath: path.join(os.tmpdir(), 'vf-alpha-binding-unused.mov'),
    workDir: os.tmpdir(), timeoutMs: 300000, workers: 3, quality: 'high',
    signal: controller.signal, onProgress() {}, onStatus() {}};
  const configuration = {getSettings: () => ({homeMotion: true}), getToken: () => 'test-token',
    endpoint: 'http://127.0.0.1:1', contract: 'binding-test',
    fetchImpl: async (url, init) => {
      state.requests.push({url, init});
      throw Error('offline');
    }};
  const native = async value => { state.native.push(value); return 'native'; };
  binding.configureMotion(configuration);
  const run = (c = context, o = options) => {
    assert.equal(typeof binding.renderOverlay, 'function', 'hot renderOverlay export is required');
    return als.run(scope, () => binding.renderOverlay(native, c, o));
  };
  return {als, controller, lease, scope, state, context, options, configuration, native, run};
}

test.afterEach(() => binding.configureMotion(null));

test('pure own binding can be required for hot activation without importing application or worker CLI modules', () => {
  const modulePath = fileURLToPath(new URL('../node/home-graphics/motion-offload/binding.mjs', import.meta.url));
  const code = `const m=require(${JSON.stringify(modulePath)});m.configureMotion(null);
    m.renderOverlay(o=>o,{},{format:'mov'}).then(o=>{if(o.format!=='mov')process.exitCode=1;});`;
  const result = spawnSync(process.execPath, ['-e', code], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr);
});

test('hot helper uses explicit alpha hook under active licensed ALS lease, preserving native options', async () => {
  const f = fixture();
  f.configuration.fetchImpl = async (url, init) => {
    f.state.requests.push({url, init});
    if (init?.method === 'POST') throw Error('offline');
    return Response.json(init?.method === 'DELETE' ? {terminated: true} :
      {version: 1, contract: 'binding-test', slots: 1, kinds: [KIND]});
  };
  assert.equal(await f.run(), 'native');
  const post = f.state.requests.find(r => r.init?.method === 'POST');
  assert.ok(post, 'must enter the explicit alpha hook rather than the opaque hook');
  const payload = JSON.parse(post.init.body);
  assert.equal(payload.kind, KIND);
  assert.equal(payload.format, 'mov');
  assert.equal(payload.duration, 3.29);
  assert.equal(payload.sourceWorkers, 3);
  assert.equal(payload.workers, 3);
  assert.equal(payload.compositionHtml, f.options.compositionHtml);
  const {timeoutMs, ...rest} = f.state.native[0];
  const {timeoutMs: originalTimeout, ...originalRest} = f.options;
  assert.deepEqual(rest, originalRest);
  assert.ok(timeoutMs > 0 && timeoutMs <= originalTimeout);
  assert.ok(f.state.checks > 0);
  assert.equal(f.scope.leases.get('render'), f.lease);
  assert.equal(f.lease.parked, false);
});

test('existing opaque binding retains native options and never dispatches alpha', async () => {
  const f = fixture();
  f.options.workers = 1;
  delete f.options.format;
  f.options.renderOnlyHtml = '<speech/><blur/>';
  f.context.duration = 3.29;
  f.configuration.fetchImpl = async (url, init) => {
    f.state.requests.push({url, init});
    if (init?.method === 'POST') throw Error('offline');
    return Response.json(init?.method === 'DELETE' ? {terminated: true} : {});
  };
  assert.equal(await f.als.run(f.scope, () => binding.render(f.native, f.context, f.options)), 'native');
  const payload = JSON.parse(f.state.requests.find(r => r.init?.method === 'POST').init.body);
  assert.equal(payload.kind, undefined);
  assert.equal(payload.format, undefined);
  assert.equal(payload.renderOnlyHtml, f.options.renderOnlyHtml);
  const {timeoutMs, ...rest} = f.state.native[0];
  const {timeoutMs: originalTimeout, ...originalRest} = f.options;
  assert.deepEqual(rest, originalRest);
  assert.ok(timeoutMs > 0 && timeoutMs <= originalTimeout);
});

for (const mode of ['disabled', 'unconfigured', 'wrong-kind', 'missing-kind', 'license', 'live-license',
  'job', 'scope-job', 'scope-lane', 'missing-lease', 'resource', 'lease-job', 'lease-lane',
  'released', 'parked', 'no-signal', 'missing-license-reader', 'non-render-context']) {
  test(`${mode}: no remote admission, original native object retained`, async () => {
    const f = fixture();
    switch (mode) {
      case 'disabled': f.configuration.getSettings = () => ({homeMotion: false}); break;
      case 'unconfigured': binding.configureMotion(null); break;
      case 'wrong-kind': f.context.kind = 'opaque'; break;
      case 'missing-kind': delete f.context.kind; break;
      case 'license': f.context.licensedJobId = 'other'; break;
      case 'live-license': f.state.licensed = 'other'; break;
      case 'job': delete f.context.jobId; break;
      case 'scope-job': f.scope.jobId = 'other'; break;
      case 'scope-lane': f.scope.lanes.clear(); break;
      case 'missing-lease': f.scope.leases.clear(); break;
      case 'resource': f.lease.resourceKey = 'remotion'; break;
      case 'lease-job': f.lease.jobId = 'other'; break;
      case 'lease-lane': f.lease.lane = 'ffmpeg'; break;
      case 'released': f.lease.released = true; break;
      case 'parked': f.lease.parked = true; break;
      case 'no-signal': delete f.lease.signal; delete f.context.outerSignal; delete f.options.signal; break;
      case 'missing-license-reader': delete f.context.getLicensedJobId; break;
      case 'non-render-context':
        f.context.lane = f.lease.lane = 'ffmpeg';
        f.scope.lanes = new Set(['ffmpeg']);
        f.scope.leases = new Map([['ffmpeg', f.lease]]);
        break;
    }
    assert.equal(await f.run(), 'native');
    assert.equal(f.state.requests.length, 0);
    assert.equal(f.state.native[0], f.options);
  });
}

for (const [name, markup] of [
  ['missing root', '<html>no timing</html>'], ['fragment', '<div data-duration="3">'],
  ['duplicate main', html().replace('</body>', '<div data-composition-id="main" data-duration="8"></div></body>')],
  ['comment spoof', '<!--' + html() + '-->'],
  ['script spoof', '<script>' + JSON.stringify(html()) + '</script>'],
  ['head spoof', html().replace('<style>', '<style><!--</style><body>')],
  ['nonzero start', html().replace('data-start="0"', 'data-start="2"')],
  ['other dimensions', html().replace('data-width="1920"', 'data-width="1280"')],
  ['duplicate duration', html().replace('data-duration="3.29"', 'data-duration="3.29" data-duration="9"')],
  ['bad numeric tail', html('3.29oops')], ['nan', html('NaN')], ['negative', html('-3')],
  ['zero', html('0')], ['too long', html('15.01')], ['oversize', html() + ' '.repeat(2 * 1024 * 1024)],
]) {
  test(`${name}: unsupported authoritative timing stays native without a remote call`, async () => {
    const f = fixture();
    f.options.compositionHtml = markup;
    f.context.duration = 1;
    assert.equal(await f.run(), 'native');
    assert.equal(f.state.requests.length, 0);
    assert.equal(f.state.native[0], f.options);
  });
}

test('duration is exact original root value, not a supplied hint or target extension', async () => {
  const f = fixture();
  f.context.duration = 99;
  f.options.compositionHtml = html('15');
  assert.equal(await f.run(), 'native');
  assert.ok(f.state.requests.length > 0);
  f.state.requests.length = 0;
  f.options.format = 'mp4';
  assert.equal(await f.run(), 'native');
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.native.at(-1), f.options);
});

for (const [name, extra] of [['workers', {workers: 4}], ['fps', {fps: 30}],
  ['resolution', {resolution: '1280x720'}], ['quality', {quality: 'custom'}],
  ['native future option', {nativeFutureOption: true}]]) {
  test(`unsupported ${name} preserves the complete native object without network`, async () => {
    const f = fixture();
    Object.assign(f.options, extra);
    assert.equal(await f.run(), 'native');
    assert.equal(f.state.requests.length, 0);
    assert.equal(f.state.native[0], f.options);
  });
}

for (const mode of ['lease', 'outer', 'options', 'job', 'checkAbort']) {
  test(`${mode} cancellation rejects before network or native fallback`, async () => {
    const f = fixture();
    if (['lease', 'outer', 'options'].includes(mode)) {
      const abort = new AbortController();
      abort.abort(Error('native cancelled'));
      if (mode === 'lease') f.lease.signal = abort.signal;
      if (mode === 'outer') f.context.outerSignal = abort.signal;
      if (mode === 'options') f.options.signal = abort.signal;
    } else if (mode === 'job') f.state.cancelled = true;
    else f.context.checkAbort = () => { throw Error('native cancelled'); };
    await assert.rejects(f.run(), /cancel|abort/i);
    assert.equal(f.state.requests.length, 0);
    assert.equal(f.state.native.length, 0);
  });
}

for (const mode of ['parked', 'released', 'replaced', 'scope', 'license', 'cancelled', 'disabled']) {
  test(`mid-hook ${mode} prevents native fallback on scope loss`, async () => {
    const f = fixture();
    f.configuration.fetchImpl = async () => {
      if (mode === 'parked' || mode === 'released') f.lease[mode] = true;
      if (mode === 'replaced') f.scope.leases.set('render', {...f.lease});
      if (mode === 'scope') f.context.getScope = () => ({...f.scope});
      if (mode === 'license') f.state.licensed = 'other';
      if (mode === 'cancelled') f.state.cancelled = true;
      if (mode === 'disabled') f.configuration.getSettings = () => ({homeMotion: false});
      throw Error('offline');
    };
    await assert.rejects(f.run(), /scope|cancel|abort/i);
    assert.equal(f.state.native.length, 0);
  });
}
