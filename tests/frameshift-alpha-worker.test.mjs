import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const kind = 'frameshift-alpha-v1';
const contract = 'synthetic-alpha-test-only';
const worker = async () => {
  const module = await import('../node/home-graphics/motion-offload/alpha-worker.mjs').catch(e => {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    return null;
  });
  assert.ok(module, 'missing alpha-worker implementation');
  return module;
};
const hookModule = async () => {
  const module = await import('../node/home-graphics/motion-offload/alpha-hook.mjs').catch(e => {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    return null;
  });
  assert.ok(module, 'missing alpha-hook implementation');
  return module;
};
const asset = Buffer.from('original asset bytes');
const payload = (change = {}) => ({
  version: 1, id: 'a'.repeat(32), contract, kind, format: 'mov',
  compositionHtml: '<html>original\r\n<body><img src="media/hero.png"></body></html>',
  renderOnlyHtml: '<script>/* original blur */</script>\n',
  assets: [{filename: 'hero.png', sha256: sha(asset), data: asset.toString('base64')}],
  fps: 24, resolution: '1920x1080', workers: 1, sourceWorkers: 3,
  quality: 'standard', duration: 0.125, timeoutMs: 60000, ...change,
});

async function temporary(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-alpha-test-'));
  try { return await fn(root); }
  finally { await fs.rm(root, {recursive: true, force: true}); }
}

async function fixture(root, {opaque = false, seconds = 0.125} = {}) {
  assert(seconds > 0 && seconds <= 1, 'synthetic fixtures must be <=1s');
  const file = path.join(root, opaque ? 'opaque.mov' : 'alpha.mov');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', `nullsrc=s=1920x1080:r=24:d=${seconds},format=yuva444p10le,geq=lum=100:cb=128:cr=128:a=${opaque ? '1023' : "'if(lt(X,W/2),0,512)'"}`,
    '-an', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le',
    '-threads', '1', '-y', file], {windowsHide: true, timeout: 30000});
  return file;
}

async function simulatedPerf(root, renderer = 'd3d11/nvidia') {
  const dir = path.join(root, '.debug', 'synthetic-job');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'perf-summary.json'), JSON.stringify({drawElement: {gpuRenderer: renderer}}));
}

test('Home may capture with up to the server worker count', async () => {
  const {validate} = await worker();
  for (const w of [1, 2, 3]) assert.equal(validate(payload({workers: w}), contract).workers, w);
  assert.throws(() => validate(payload({workers: 2, sourceWorkers: 1}), contract));
});

test('strict explicit alpha payload preserves the original source', async () => {
  const {validate} = await worker();
  const p = payload();
  assert.equal(validate(p, contract), p);
  assert.equal(p.workers, 1);
  assert.equal(p.sourceWorkers, 3);
});

for (const [name, change] of Object.entries({
  kind: {kind: undefined}, opaqueKind: {kind: 'custom_animation'}, mp4: {format: 'mp4'},
  fps: {fps: 30}, resolution: {resolution: '1280x720'}, zero: {duration: 0},
  long: {duration: 15.01}, nonfinite: {duration: NaN}, remoteWorkers: {workers: 4}, remoteAboveSource: {workers: 3, sourceWorkers: 2},
  fractionalRemote: {workers: 1.5},
  sourceWorkers: {sourceWorkers: 4}, fractionalWorkers: {sourceWorkers: 1.5},
  quality: {quality: 'ultra'}, deadline: {timeoutMs: 600001}, id: {id: '../escape'},
  html: {compositionHtml: 'x'.repeat(2 * 1024 * 1024 + 1)},
  traversal: {assets: [{...payload().assets[0], filename: '../hero.png'}]},
  hash: {assets: [{...payload().assets[0], sha256: '0'.repeat(64)}]},
  base64: {assets: [{...payload().assets[0], data: payload().assets[0].data + '!'}]},
  duplicate: {assets: [payload().assets[0], payload().assets[0]]},
  alias: {assets: [payload().assets[0], {...payload().assets[0], filename: 'HERO.png'}]},
  url: {assets: [{...payload().assets[0], url: 'https://not-used.invalid'}]},
})) {
  test(`rejects unsafe payload: ${name}`, async () => {
    const {validate} = await worker();
    assert.throws(() => validate(payload(change), contract));
  });
}

test('body and artifact caps remain exactly 48MiB and 32MiB', async () => {
  const {MAX_BODY, MAX_ARTIFACT, validate} = await worker();
  assert.equal(MAX_BODY, 48 * 1024 * 1024);
  assert.equal(MAX_ARTIFACT, 32 * 1024 * 1024);
  const big = Buffer.alloc(MAX_ARTIFACT + 1);
  assert.throws(() => validate(payload({assets: [{filename: 'big', sha256: sha(big), data: big.toString('base64')}]}), contract));
});

test('valid base64 at the existing 32MiB boundary does not overflow the parser stack', async () => {
  const {validate, MAX_ARTIFACT} = await worker();
  const bytes = Buffer.alloc(MAX_ARTIFACT, 37);
  const p = payload({assets: [{filename: 'boundary', sha256: sha(bytes), data: bytes.toString('base64')}]});
  assert.equal(validate(p, contract), p);
});

test('real CPU synthetic MOV verifies ProRes4444, native frames, duration and nonopaque alpha', async () => {
  const {verify} = await worker();
  await temporary(async root => {
    const proof = await verify(await fixture(root), payload());
    assert.equal(proof.codec, 'prores');
    assert.equal(proof.profile, '4444');
    assert.equal(proof.frames, 3);
    assert.equal(proof.duration, 0.125);
    assert.equal(proof.alpha.frames, 3);
    assert(proof.alpha.min < 255 && proof.alpha.max > 0);
  });
});

test('an alpha-capable codec without actual transparency is rejected', async () => {
  const {verify} = await worker();
  await temporary(async root => assert.rejects(verify(await fixture(root, {opaque: true}), payload()), /alpha/));
});

test('wrong native duration/frame count and truncated MOV fail verification', async () => {
  const {verify} = await worker();
  await temporary(async root => {
    const file = await fixture(root);
    await assert.rejects(verify(file, payload({duration: 0.25})), /output contract/);
    const bytes = await fs.readFile(file);
    const broken = path.join(root, 'broken.mov');
    await fs.writeFile(broken, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await assert.rejects(verify(broken, payload()));
  });
});

test('header checks reject H264, missing alpha, wrong MOV profile, streams, rate, duration and timebase', async () => {
  const {checkProbe} = await worker();
  const v = {codec_type: 'video', codec_name: 'prores', profile: '4444', codec_tag_string: 'ap4h',
    pix_fmt: 'yuva444p12le', width: 1920, height: 1080, avg_frame_rate: '24/1', r_frame_rate: '24/1',
    time_base: '1/12288', nb_read_frames: '3', duration: '0.125000'};
  const probe = (video = v) => ({streams: [video], format: {tags: {major_brand: 'qt  '}}});
  checkProbe(probe(), payload());
  for (const change of [{codec_name: 'h264'}, {profile: '4444 XQ'}, {codec_tag_string: 'ap4x'},
    {pix_fmt: 'yuv444p12le'}, {width: 1280}, {avg_frame_rate: '30/1'}, {r_frame_rate: '30/1'},
    {nb_read_frames: '4'}, {duration: 'NaN'}, {duration: '0.130'}, {time_base: '1/24'}]) {
    assert.throws(() => checkProbe(probe({...v, ...change}), payload()), /output contract/);
  }
  assert.throws(() => checkProbe({...probe(), streams: [v, {codec_type: 'audio'}]}, payload()));
  assert.throws(() => checkProbe({...probe(), format: {tags: {major_brand: 'isom'}}}, payload()));
});

test('worker renders MOV with original HTML/assets/renderOnly and remote workers1; receipt binds all input', async () => {
  const {execute, payloadSha256} = await worker();
  await temporary(async root => {
    const original = payload();
    const config = {contract, jobRoot: root};
    const result = await execute(original, config, {renderNative: async (options, _config) => {
      assert.equal(options.compositionHtml, original.compositionHtml);
      assert.equal(options.renderOnlyHtml, original.renderOnlyHtml);
      assert.equal(options.format, 'mov');
      assert.equal(options.workers, 1);
      assert.equal(options.quality, original.quality);
      assert.equal(options.timeoutMs, original.timeoutMs);
      assert.deepEqual(await fs.readFile(options.assets[0].localPath), asset);
      assert.equal(options.assets[0].filename, 'hero.png');
      await fs.copyFile(await fixture(options.workDir), options.targetPath);
      await simulatedPerf(options.workDir);
    }});
    assert.equal(result.kind, kind);
    assert.equal(result.payloadSha256, payloadSha256(original));
    assert.equal(result.sha256, sha(Buffer.from(result.data, 'base64')));
    assert.equal(result.backend, 'd3d11/nvidia');
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('worker requires pinned runtime and never accepts software/no perf evidence', async () => {
  const {execute, renderPinned} = await worker();
  await assert.rejects(renderPinned({}, {}), /runtime pins/);
  await temporary(async root => {
    for (const evidence of [null, 'swiftshader', 'software rasterizer']) {
      await assert.rejects(execute(payload(), {contract, jobRoot: root}, {renderNative: async o => {
        await fs.copyFile(await fixture(o.workDir), o.targetPath);
        if (evidence) await simulatedPerf(o.workDir, evidence);
      }}), /hardware proof/);
    }
    assert.deepEqual(await fs.readdir(root), []);
  });
});

async function parallelPerf(root, extra = {}) {
  const dir = path.join(root, '.debug', 'parallel-job');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'perf-summary.json'), JSON.stringify({drawElement: {mode: 'screenshot', clampReason: 'parallel', ...extra}}));
}

test('parallel screenshot capture is proven by probing the pinned browser, once', async () => {
  const {execute} = await worker();
  await temporary(async root => {
    let probes = 0;
    const result = await execute(payload({workers: 3, sourceWorkers: 3}), {contract, jobRoot: root}, {
      renderNative: async o => { await fs.copyFile(await fixture(o.workDir), o.targetPath); await parallelPerf(o.workDir); },
      probeGpu: async (config, workDir) => { probes++; assert.equal(config.contract, contract); assert.ok(workDir.startsWith(root)); return 'd3d11/nvidia'; }});
    assert.equal(result.backend, 'd3d11/nvidia');
    assert.equal(probes, 1);
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('parallel proof fails closed: software probe, probe error, unclamped screenshot, foreign renderer', async () => {
  const {execute} = await worker();
  await temporary(async root => {
    const cases = [
      [o => parallelPerf(o.workDir), async () => 'swiftshader/other'],
      [o => parallelPerf(o.workDir), async () => { throw Error('launch failed'); }],
      [o => parallelPerf(o.workDir, {clampReason: undefined}), async () => 'd3d11/nvidia'],
      [o => parallelPerf(o.workDir, {gpuRenderer: 'swiftshader/other'}), async () => 'd3d11/nvidia'],
      [async o => { await parallelPerf(o.workDir); await simulatedPerf(o.workDir, 'swiftshader'); }, async () => 'd3d11/nvidia'],
    ];
    for (const [perf, probeGpu] of cases) {
      await assert.rejects(execute(payload({workers: 3, sourceWorkers: 3}), {contract, jobRoot: root}, {
        renderNative: async o => { await fs.copyFile(await fixture(o.workDir), o.targetPath); await perf(o); }, probeGpu}), /hardware proof/);
    }
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('compile-gated screenshot capture (e.g. mix_blend_mode) is proven by the probe too', async () => {
  const {execute, proveBackend} = await worker();
  await temporary(async root => {
    let probes = 0;
    const result = await execute(payload(), {contract, jobRoot: root}, {
      renderNative: async o => { await fs.copyFile(await fixture(o.workDir), o.targetPath); await parallelPerf(o.workDir, {clampReason: undefined, compileGate: 'mix_blend_mode'}); },
      probeGpu: async () => { probes++; return 'd3d11/nvidia'; }});
    assert.equal(result.backend, 'd3d11/nvidia');
    assert.equal(probes, 1);
  });
  const probe = async () => 'd3d11/nvidia';
  for (const d of [{mode: 'screenshot', compileGate: ''}, {mode: 'drawelement', compileGate: 'mix_blend_mode'},
    {mode: 'screenshot', compileGate: 'mix_blend_mode', gpuRenderer: 'swiftshader/other'}, {mode: 'screenshot', compileGate: 7}]) {
    await assert.rejects(proveBackend([d], probe), /hardware proof/);
  }
  await assert.rejects(proveBackend([{mode: 'screenshot', compileGate: 'mix_blend_mode'}], async () => 'swiftshader/other'), /hardware proof/);
});

test('alphaExtrema equals a full byte loop for every chunk shape', async () => {
  const {alphaExtrema} = await worker();
  const naive = (chunks) => { let min = 255, max = 0; for (const c of chunks) for (const v of c) { if (v < min) min = v; if (v > max) max = v; } return {min, max}; };
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shapes = [() => Buffer.alloc(64, 255), () => Buffer.alloc(64, 0), () => Buffer.alloc(64, 128),
    () => Buffer.from(Array.from({length: 64}, () => 1 + Math.floor(rnd() * 253))),
    () => Buffer.from(Array.from({length: 64}, () => Math.floor(rnd() * 256)))];
  for (let n = 0; n < 200; n++) {
    const chunks = Array.from({length: 1 + Math.floor(rnd() * 4)}, () => shapes[Math.floor(rnd() * shapes.length)]());
    let state = {min: 255, max: 0};
    for (const c of chunks) state = alphaExtrema(c, state.min, state.max);
    assert.deepEqual(state, naive(chunks));
  }
});

test('single-worker evidence never launches the probe', async () => {
  const {execute} = await worker();
  await temporary(async root => {
    const probeGpu = async () => { throw Error('probe must not run'); };
    const result = await execute(payload(), {contract, jobRoot: root}, {probeGpu,
      renderNative: async o => { await fs.copyFile(await fixture(o.workDir), o.targetPath); await simulatedPerf(o.workDir); }});
    assert.equal(result.backend, 'd3d11/nvidia');
    await assert.rejects(execute(payload(), {contract, jobRoot: root}, {probeGpu,
      renderNative: async o => { await fs.copyFile(await fixture(o.workDir), o.targetPath); }}), /hardware proof/);
  });
});

test('renderer classification matches the Home GTX D3D11 string and rejects SwiftShader', async () => {
  const {classifyRenderer, HARDWARE_GPU_ARGS} = await worker();
  assert.equal(classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Ti (0x000017C8) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'd3d11/nvidia');
  assert.equal(classifyRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'swiftshader/other');
  assert.equal(classifyRenderer(null), null);
  assert.ok(HARDWARE_GPU_ARGS.includes('--use-angle=d3d11') && !HARDWARE_GPU_ARGS.some(a => /swiftshader/.test(a)));
});

test('uploaded perf-summary asset cannot forge renderer hardware evidence', async () => {
  const {execute} = await worker();
  await temporary(async root => {
    const bytes = Buffer.from(JSON.stringify({gpuRenderer: 'd3d11/nvidia'}));
    const p = payload({assets: [{filename: 'perf-summary.json', sha256: sha(bytes), data: bytes.toString('base64')}]});
    await assert.rejects(execute(p, {contract, jobRoot: root}, {renderNative: async o => {
      await fs.copyFile(await fixture(o.workDir), o.targetPath);
    }}), /hardware proof/);
    assert.deepEqual(await fs.readdir(root), []);
  });
});

async function harness(root, change = {}) {
  const {createAlphaHook} = await hookModule();
  const {verify, payloadSha256} = await worker();
  const file = await fixture(root);
  const bytes = await fs.readFile(file);
  const calls = [], nativeOptions = [], posted = [];
  const options = {compositionHtml: payload().compositionHtml, renderOnlyHtml: payload().renderOnlyHtml,
    assets: [{filename: 'hero.png', localPath: path.join(root, 'hero.png')}],
    format: 'mov', fps: 24, resolution: '1920x1080', workers: 3, quality: 'standard',
    timeoutMs: 300000, workDir: root, targetPath: path.join(root, 'final.mov'),
    onProgress() {}, onStatus() {}};
  await fs.writeFile(options.assets[0].localPath, asset);
  const config = {endpoint: 'http://127.0.0.1:18191', contract, token: 'synthetic-no-secret',
    permitted: () => true,
    fetchImpl: async (url, init) => {
      const method = init.method ?? 'GET'; calls.push([method, url.pathname]);
      if (change.fetch) return change.fetch(url, init, calls);
      if (method === 'GET') return Response.json({version: 1, contract, slots: 1, kinds: [kind]});
      if (method === 'DELETE') return Response.json({terminated: true});
      const p = JSON.parse(init.body); posted.push(p);
      const receipt = {version: 1, id: p.id, contract, kind, format: 'mov', backend: 'd3d11/nvidia',
        payloadSha256: payloadSha256(p), sha256: sha(bytes), data: bytes.toString('base64'), probe: await verify(file, p)};
      return Response.json(change.receipt ? change.receipt(receipt) : receipt);
    }, ...change.config};
  const native = async o => { calls.push(['native']); nativeOptions.push(o); return 'native'; };
  return {options, config, calls, nativeOptions, posted,
    hook: createAlphaHook(native, config), native};
}

test('hook atomically publishes only independently verified alpha and strict receipt', async () => temporary(async root => {
  const h = await harness(root);
  const before = {...h.options};
  const result = await h.hook(h.options, {kind, duration: 0.125});
  assert.equal(result.videoPath, h.options.targetPath);
  assert.equal(h.nativeOptions.length, 0);
  assert.deepEqual(h.options, before);
  assert.equal(h.posted[0].workers, 3, 'Home captures with the server worker count');
  assert.equal(h.posted[0].sourceWorkers, 3);
  assert.equal(h.posted[0].format, 'mov');
  assert.equal(h.posted[0].compositionHtml, h.options.compositionHtml);
  assert.equal(h.posted[0].renderOnlyHtml, h.options.renderOnlyHtml);
  assert.equal(h.posted[0].assets[0].data, asset.toString('base64'));
  assert.equal((await fs.readdir(root)).some(n => n.endsWith('.part')), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'artifacts', 'home-alpha-receipt.json'))).kind, kind);
}));

test('explicit kind and source eligibility gate before any network, preserving exact native options', async () => temporary(async root => {
  const h = await harness(root);
  for (const [change, ctx] of [[{}, {}], [{format: 'mp4'}, {kind}], [{workers: 4}, {kind}],
    [{fps: 30}, {kind}], [{resolution: '1280x720'}, {kind}], [{quality: 'unknown'}, {kind}],
    [{}, {kind, duration: 16}], [{unsupportedNativeOption: true}, {kind}]]) {
    const o = {...h.options, ...change};
    assert.equal(await h.hook(o, {duration: 0.125, ...ctx}), 'native');
    assert.equal(h.nativeOptions.at(-1), o);
  }
  assert.equal(h.calls.filter(c => c[0] !== 'native').length, 0);
}));

for (const field of ['sha256', 'id', 'contract', 'kind', 'format', 'payloadSha256', 'backend', 'probe', 'data']) {
  test(`receipt tampering cannot publish: ${field}`, async () => temporary(async root => {
    const h = await harness(root, {receipt: r => ({...r, [field]: field === 'probe' ? {...r.probe, frames: 99} : 'tampered'})});
    await fs.writeFile(h.options.targetPath, 'prior target');
    assert.equal(await h.hook(h.options, {kind, duration: 0.125}), 'native');
    assert.equal(await fs.readFile(h.options.targetPath, 'utf8'), 'prior target');
    assert.deepEqual(h.calls.map(c => c[0]), ['GET', 'POST', 'DELETE', 'native']);
    assert.match(h.calls[2][1], /^\/motion\/[a-f0-9]{32}$/);
    assert.equal(h.nativeOptions[0].workers, 3);
    assert.equal(h.nativeOptions[0].format, 'mov');
  }));
}

test('unconfirmed owned DELETE quarantines endpoint+contract across hook instances', async () => temporary(async root => {
  const h = await harness(root, {config: {contract: 'quarantine-test'}, fetch: async (_url, init) => {
    if (init.method === 'POST') throw Error('lost response');
    if (init.method === 'DELETE') return Response.json({}, {status: 503});
    return Response.json({version: 1, contract: 'quarantine-test', slots: 1, kinds: [kind]});
  }});
  assert.equal(await h.hook(h.options, {kind, duration: 0.125}), 'native');
  const before = h.calls.length;
  const {createAlphaHook} = await hookModule();
  assert.equal(await createAlphaHook(h.native, h.config)(h.options, {kind, duration: 0.125}), 'native');
  assert.equal(h.calls.length, before + 1);
}));

test('outer cancellation before/during POST cleans owned job with no native retry', async () => temporary(async root => {
  const controller = new AbortController();
  const h = await harness(root, {fetch: async (_url, init) => {
    if (init.method === 'POST') {
      controller.abort(Error('owner cancelled'));
      throw controller.signal.reason;
    }
    return Response.json(init.method === 'DELETE' ? {terminated: true} : {version: 1, contract, slots: 1, kinds: [kind]});
  }});
  await assert.rejects(h.hook(h.options, {kind, duration: 0.125, signal: controller.signal}), /owner cancelled/);
  assert.deepEqual(h.calls.map(c => c[0]), ['GET', 'POST', 'DELETE']);
  const n = h.calls.length;
  await assert.rejects(h.hook(h.options, {kind, duration: 0.125, signal: controller.signal}), /owner cancelled/);
  assert.equal(h.calls.length, n);
  assert.equal(h.nativeOptions.length, 0);
}));

test('superseded lease after verification never publishes or starts native fallback', async () => temporary(async root => {
  let valid = true;
  const h = await harness(root, {config: {permitted: () => valid}, receipt: r => {valid = false; return r;}});
  await assert.rejects(h.hook(h.options, {kind, duration: 0.125}), /scope superseded/);
  await assert.rejects(fs.stat(h.options.targetPath), {code: 'ENOENT'});
  assert.equal(h.nativeOptions.length, 0);
  assert.equal(h.calls.at(-1)[0], 'DELETE');
}));

test('health contract mismatch fails closed before POST', async () => temporary(async root => {
  const h = await harness(root, {fetch: async () => Response.json({version: 1, contract: 'opaque-only', slots: 1})});
  assert.equal(await h.hook(h.options, {kind, duration: 0.125}), 'native');
  assert.deepEqual(h.calls.map(c => c[0]), ['GET', 'native']);
}));

test('remote attempt and owned cleanup consume the ORIGINAL native deadline; only timeout changes', async () => temporary(async root => {
  const realNow = Date.now;
  let elapsed = 0;
  const h = await harness(root, {fetch: async (_url, init) => {
    if (init.method === 'POST') { elapsed += JSON.parse(init.body).timeoutMs; throw Error('remote deadline'); }
    if (init.method === 'DELETE') elapsed += 12000;
    return Response.json(init.method === 'DELETE' ? {terminated: true} : {version: 1, contract, slots: 1, kinds: [kind]});
  }});
  Date.now = () => realNow() + elapsed;
  try {
    assert.equal(await h.hook(h.options, {kind, duration: 0.125}), 'native');
    const fallback = h.nativeOptions[0];
    assert(fallback.timeoutMs <= 18000 && fallback.timeoutMs > 16000);
    assert.deepEqual({...fallback, timeoutMs: h.options.timeoutMs}, h.options);
  } finally { Date.now = realNow; }
}));

// Home share = 12 s - 4 s reserve = 8 s; the body arrives after ~9 s.
// Live 2026-10-17 00:11: Home answered after 156 s, the loaded server needed >54 s to receive and
// verify, the Home-share timer (70% of 300 s) fired and the finished GPU render was thrown away.
async function slowBodyHarness(root, freshNativeBudget) {
  const {verify, payloadSha256} = await worker();
  const file = await fixture(root), bytes = await fs.readFile(file);
  return harness(root, {config: {nativeReserveRatio: 0.3, freshNativeBudget}, fetch: async (_url, init) => {
    if (init.method === 'DELETE') return Response.json({terminated: true});
    if ((init.method ?? 'GET') === 'GET') return Response.json({version: 1, contract, slots: 1, kinds: [kind]});
    const p = JSON.parse(init.body);
    const receipt = JSON.stringify({version: 1, id: p.id, contract, kind, format: 'mov', backend: 'd3d11/nvidia',
      payloadSha256: payloadSha256(p), sha256: sha(bytes), data: bytes.toString('base64'), probe: await verify(file, p)});
    await new Promise(r => setTimeout(r, 300));
    const body = new ReadableStream({start(c) {
      const t = setTimeout(() => { c.enqueue(new TextEncoder().encode(receipt)); c.close(); }, 8500);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); c.error(init.signal.reason); }, {once: true});
    }});
    return new Response(body, {status: 200, headers: {'content-type': 'application/json'}});
  }});
}

test('finished Home render is kept when receiving it outlasts the Home share (fresh native budget)', async () => temporary(async root => {
  const h = await slowBodyHarness(root, true);
  const result = await h.hook({...h.options, timeoutMs: 12000}, {kind, duration: 0.125});
  assert.equal(result.videoPath, h.options.targetPath);
  assert.equal(h.nativeOptions.length, 0);
  assert.equal(h.calls.some(c => c[0] === 'DELETE'), false);
}));

test('without a fresh native budget the Home share still bounds receiving', async () => temporary(async root => {
  const h = await slowBodyHarness(root, false);
  assert.equal(await h.hook({...h.options, timeoutMs: 12000}, {kind, duration: 0.125}), 'native');
  assert.equal(h.calls.some(c => c[0] === 'DELETE'), true);
}));

test('unsafe endpoint is rejected without HTTP or renderer startup', async () => {
  const {createAlphaHook} = await hookModule();
  for (const endpoint of ['https://example.com', 'http://10.0.3.2:18191', 'http://user:pass@localhost:18191', 'http://localhost:18191/motion']) {
    assert.throws(() => createAlphaHook(() => {}, {endpoint, contract}), /private tunnel/);
  }
});

test('homeShare gives Home that share of the deadline, also beyond it, capped at Home 600 s', async () => temporary(async root => {
  for (const [share, timeoutMs, expected] of [[1.5, 300000, 450000], [0.7, 300000, 210000], [2, 300000, 600000], [2, 400000, 600000], [0.95, 300000, 285000]]) {
    const h = await harness(root, {config: {freshNativeBudget: true, homeShare: share, nativeReserveRatio: 0.3}});
    await h.hook({...h.options, timeoutMs}, {kind, duration: 0.125});
    const sent = h.posted[0].timeoutMs;
    assert.ok(sent <= expected && sent > expected - 2000, `share ${share} of ${timeoutMs}: Home got ${sent}, expected ~${expected}`);
    await fs.rm(path.join(root, 'final.mov'), {force: true});
  }
}));

test('invalid homeShare, or no fresh native budget, keeps the reserve-based deadline', async () => temporary(async root => {
  for (const config of [{freshNativeBudget: true, homeShare: 2.5, nativeReserveRatio: 0.3}, {freshNativeBudget: true, homeShare: 0.4, nativeReserveRatio: 0.3},
    {freshNativeBudget: false, homeShare: 1.5, nativeReserveRatio: 0.3}, {freshNativeBudget: true, homeShare: '1.5', nativeReserveRatio: 0.3}]) {
    const h = await harness(root, {config});
    await h.hook(h.options, {kind, duration: 0.125});
    const sent = h.posted[0].timeoutMs;
    assert.ok(sent <= 210000 && sent > 208000, `${JSON.stringify(config)} -> ${sent}`);
    await fs.rm(path.join(root, 'final.mov'), {force: true});
  }
}));

test('a Home failure after a long share still gives the native fallback its full deadline', async () => temporary(async root => {
  const h = await harness(root, {config: {freshNativeBudget: true, homeShare: 1.5}, fetch: async (_url, init) =>
    (init.method ?? 'GET') === 'GET' ? Response.json({version: 1, contract, slots: 4, kinds: [kind]})
      : (init.method === 'DELETE' ? Response.json({terminated: true}) : new Response('{"error":"unavailable"}', {status: 503}))});
  assert.equal(await h.hook(h.options, {kind, duration: 0.125}), 'native');
  assert.equal(h.nativeOptions[0].timeoutMs, 300000);
}));
