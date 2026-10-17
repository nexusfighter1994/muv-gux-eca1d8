'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createFrameshiftRoute } = require('../node/home-graphics/motion-offload/frameshift-route.cjs');

const ALPHA = '<!doctype html><html><head><meta charset="utf-8"><style>a{}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="3.4" data-width="1920" data-height="1080">x</div></body></html>';
const OPAQUE = '<html><div data-composition-id="main" data-duration="2.5">x</div></html>';

function setup({ homeFails = false, licensed = 'job', homeMotion = true } = {}) {
  const als = new AsyncLocalStorage();
  const lease = { resourceKey: 'frameshift', released: false, parked: false, signal: new AbortController().signal };
  const scope = { jobId: 'job', lanes: new Set(['render']), leases: new Map([['render', lease]]) };
  const calls = { home: [], native: [] };
  const fakeHook = kind => (fallback, cfg) => async (options, meta) => {
    assert.equal(cfg.freshNativeBudget, true);
    assert.ok(cfg.permitted());
    calls.home.push({ kind, meta, workers: options.workers });
    if (homeFails) return fallback({ ...options, timeoutMs: options.timeoutMs });
    return { videoPath: options.targetPath, home: kind };
  };
  const route = createFrameshiftRoute({ RU: () => licensed, getStore: () => als.getStore(), mF: () => 'render',
    jp: new Map([['job', { checkAbort() {} }]]), Xl: () => null, isJobAborted: () => false,
    getConfig: () => ({ getSettings: () => ({ homeMotion }), getToken: () => 't', contract: 'c' }),
    loadAlpha: async () => ({ createAlphaHook: fakeHook('alpha') }), loadOpaque: async () => ({ createMotionHook: fakeHook('opaque') }) });
  let render = async function (options) { calls.native.push(options); return { native: true }; };
  render = route.wrap(render);
  const run = options => als.run(scope, () => render(options));
  return { route, run, calls, render };
}
const base = { fps: 24, resolution: '1920x1080', targetPath: '/t/out', workDir: '/t', timeoutMs: 600000, assets: [{ filename: 'a.png', localPath: '/t/a.png' }] };

test('alpha MOV overlay and opaque MP4 (workers 3) are routed to Home', async () => {
  const s = setup();
  assert.equal((await s.run({ ...base, compositionHtml: ALPHA, format: 'mov', workers: 3, quality: 'high' })).home, 'alpha');
  assert.equal((await s.run({ ...base, compositionHtml: OPAQUE, workers: 3 })).home, 'opaque');
  assert.equal(s.calls.native.length, 0);
  assert.equal(s.calls.home[0].meta.kind, 'frameshift-alpha-v1');
  assert.equal(s.calls.home[0].meta.duration, 3.4);
  assert.equal(s.calls.home[1].meta.duration, 2.5);
  assert.deepEqual(s.route.stats.alpha, { tried: 1, home: 1, native: 0 });
});

test('Home failure falls back exactly once to the original renderer, inside bypass', async () => {
  const s = setup({ homeFails: true });
  assert.deepEqual(await s.run({ ...base, compositionHtml: OPAQUE, workers: 3 }), { native: true });
  assert.equal(s.calls.native.length, 1);
  assert.equal(s.calls.home.length, 1);
  assert.equal(s.route.stats.opaque.native, 1);
});

test('nested calls inside bypass are never re-offered', async () => {
  const s = setup();
  await s.route.bypass.run(true, () => s.run({ ...base, compositionHtml: OPAQUE, workers: 3 }));
  assert.equal(s.calls.home.length, 0);
  assert.equal(s.route.stats.bypassed, 1);
});

test('refusals stay native and record a reason', async () => {
  for (const [opts, reason, extra] of [
    [{ compositionHtml: ALPHA, format: 'mov', fps: 30 }, 'alpha_fps_30'],
    [{ compositionHtml: ALPHA, format: 'mov', assets: [{ filename: 'f', localPath: '/f', mime: 'x' }] }, 'alpha_asset_keys_filename+localPath+mime'],
    [{ compositionHtml: '<div>no</div>', format: 'mov' }, 'alpha_composition'],
    [{ compositionHtml: OPAQUE, workers: 4 }, 'workers_4'],
    [{ compositionHtml: OPAQUE, format: 'webm' }, 'format_webm'],
    [{ compositionHtml: OPAQUE }, 'license_mismatch', { licensed: 'other' }],
    [{ compositionHtml: OPAQUE }, 'home_disabled', { homeMotion: false }],
  ]) {
    const s = setup(extra);
    assert.deepEqual(await s.run({ ...base, ...opts }), { native: true }, reason);
    assert.equal(s.calls.home.length, 0, reason);
    assert.equal(s.route.stats.reasons[reason], 1, reason + ' ' + JSON.stringify(s.route.stats.reasons));
  }
});

test('low level: original render path reaches Home with exact composition, render-only markup and media', async () => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-route-'));
  try {
    for (const homeFails of [false, true]) {
      const s = setup({ homeFails });
      const seen = [];
      const fakeHook = (fallback, cfg) => async (options, meta) => {
        seen.push({ options, meta });
        if (homeFails) return fallback(options);
        await fs.writeFile(options.targetPath, 'home-output');
        return { videoPath: options.targetPath };
      };
      const route = createFrameshiftRoute({ RU: () => 'job', getStore: () => s.als?.getStore?.(), mF: () => 'render', jp: new Map(), Xl: () => null,
        isJobAborted: () => false, getConfig: () => ({ getSettings: () => ({ homeMotion: true }), getToken: () => 't', contract: 'c' }),
        loadAlpha: async () => ({ createAlphaHook: fakeHook }), loadOpaque: async () => ({ createMotionHook: fakeHook }) });
      const { AsyncLocalStorage } = require('node:async_hooks');
      const als = new AsyncLocalStorage();
      const lease = { resourceKey: 'frameshift', released: false, parked: false, signal: new AbortController().signal };
      const scope = { jobId: 'job', lanes: new Set(['render']), leases: new Map([['render', lease]]) };
      s.als = als;
      let nativeRuns = 0;
      const materialize = route.wrapMaterialize(async (workDir, html) => {
        const p = { projectDir: path.join(workDir, 'project'), mediaDir: path.join(workDir, 'project', 'media'), outputDir: path.join(workDir, 'out'), artifactsDir: path.join(workDir, 'artifacts') };
        for (const d of [p.mediaDir, p.outputDir, p.artifactsDir]) await fs.mkdir(d, { recursive: true });
        await fs.writeFile(path.join(p.projectDir, 'index.html'), html);
        await fs.writeFile(path.join(p.mediaDir, 'hero.png'), 'png');
        return p;
      });
      const runRender = route.wrapRunRender(async args => { nativeRuns++; await fs.writeFile(args.outputPath, 'native'); return { code: 0, timedOut: false, stdout: 'n', stderr: '' }; });
      const workDir = path.join(dir, String(homeFails));
      const html = ALPHA.replace('</body>', '<img src="media/hero.png"></body>');
      // Exactly what the native render() does between materialize and runRender.
      const result = await als.run(scope, async () => {
        const p = await materialize(workDir, html);
        await fs.writeFile(path.join(p.projectDir, 'index.html'), html.replace('</body>', '<script>blur()</script>\n</body>'));
        return runRender({ projectDir: p.projectDir, outputPath: path.join(p.outputDir, 'video.mov'), fps: 24, format: 'mov', timeoutMs: 600000, workers: 3, quality: 'high' });
      });
      assert.equal(result.code, 0);
      assert.equal(seen[0].options.compositionHtml, html);
      assert.equal(seen[0].options.renderOnlyHtml, '<script>blur()</script>');
      assert.deepEqual(seen[0].options.assets.map(a => a.filename), ['hero.png']);
      assert.equal(seen[0].meta.kind, 'frameshift-alpha-v1');
      assert.equal(nativeRuns, homeFails ? 1 : 0);
      assert.equal(await fs.readFile(path.join(workDir, 'out', 'video.mov'), 'utf8'), homeFails ? 'native' : 'home-output');
      assert.deepEqual(route.stats.low, { calls: 1, tried: 1, home: homeFails ? 0 : 1, native: homeFails ? 1 : 0 });
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('lease without AbortSignal: watchdog aborts the Home render when the lease ends, no native fallback', async () => {
  const als = new AsyncLocalStorage();
  const lease = { resourceKey: 'frameshift', released: false, parked: false };
  const scope = { jobId: 'job', lanes: new Set(['render']), leases: new Map([['render', lease]]) };
  let native = 0;
  const hook = (fallback, cfg) => (options, meta) => new Promise((resolve, reject) => {
    assert.ok(meta.signal instanceof AbortSignal);
    meta.signal.addEventListener('abort', () => reject(meta.signal.reason), { once: true });
  });
  const route = createFrameshiftRoute({ RU: () => 'job', getStore: () => als.getStore(), mF: () => 'render', jp: new Map(), Xl: () => null,
    isJobAborted: () => false, getConfig: () => ({ getSettings: () => ({ homeMotion: true }), getToken: () => 't', contract: 'c' }),
    loadAlpha: async () => ({ createAlphaHook: hook }), loadOpaque: async () => ({ createMotionHook: hook }) });
  const render = route.wrap(async () => { native++; return { native: true }; });
  setTimeout(() => { lease.released = true; }, 50);
  const keepAlive = setTimeout(() => {}, 10000); // the watchdog timer is unref'd, like in production
  await assert.rejects(als.run(scope, () => render({ ...base, compositionHtml: OPAQUE, workers: 3 })), /native render scope ended/);
  clearTimeout(keepAlive);
  assert.equal(native, 0);
  assert.equal(route.stats.watchdog, 1);
});

test('only one concurrent Home offer (Home has one graphics slot); slot freed before server fallback', async () => {
  const als = new AsyncLocalStorage();
  const lease = { resourceKey: 'frameshift', released: false, parked: false, signal: new AbortController().signal };
  const scope = { jobId: 'job', lanes: new Set(['render']), leases: new Map([['render', lease]]) };
  let release, homeCalls = 0, native = 0;
  const gate = new Promise(r => { release = r; });
  const hook = (fallback) => async (options) => { homeCalls++; await gate; return options.fail ? fallback(options) : { home: true }; };
  const route = createFrameshiftRoute({ RU: () => 'job', getStore: () => als.getStore(), mF: () => 'render', jp: new Map(), Xl: () => null,
    isJobAborted: () => false, getConfig: () => ({ getSettings: () => ({ homeMotion: true }), getToken: () => 't', contract: 'c' }),
    loadAlpha: async () => ({ createAlphaHook: hook }), loadOpaque: async () => ({ createMotionHook: hook }) });
  const render = route.wrap(async () => { native++; return { native: true }; });
  const first = als.run(scope, () => render({ ...base, compositionHtml: OPAQUE, workers: 3 }));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(await als.run(scope, () => render({ ...base, compositionHtml: OPAQUE, workers: 3 })), { native: true });
  assert.equal(route.stats.reasons.home_busy, 1);
  release();
  assert.deepEqual(await first, { home: true });
  assert.deepEqual(await als.run(scope, () => render({ ...base, compositionHtml: OPAQUE, workers: 3 })), { home: true }, 'slot released after success');
  assert.equal(homeCalls, 2);
});

test('wrap is idempotent', () => {
  const s = setup();
  assert.equal(s.route.wrap(s.render), s.render);
});
