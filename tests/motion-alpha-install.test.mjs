import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {patchBundle} from '../node/home-graphics/motion-offload/install.mjs';
import {configureMotion, renderOverlay} from '../node/home-graphics/motion-offload/binding.mjs';

const stock = fs.readFileSync(path.resolve(process.env.VF_ALPHA_STOCK ??
  'scratch/vf-update-20261015/stock-new.mjs'), 'utf8');
const modulePath = './vf-custom/home-graphics/motion-offload/binding.mjs';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('lease fields checked by binding come from the actual stock scheduler grant, not a test-only schema', () => {
  const scheduler = extract(stock, 'async function ghe(', 'function Sbi(');
  assert.ok(scheduler.includes('y={lane:i,jobId:e,resourceKey:o,priority:g,boosted:!!b?.boosted,cooldownProbe:!!b?.cooldownProbe,opKey:h.segmentType||null,quality:h.quality||null,signal:a,parked:!1,released:!1}'));
  assert.ok(scheduler.includes('I.set(i,y)'));
  assert.ok(scheduler.includes('fhe.run({jobId:e,lanes:k,leases:I},R)'));
  assert.ok(stock.includes('function mF(e){return e==="fflow"?"ffmpeg":V0i.has(e)?"render":e}'));
});

test('pinned stock gets exactly one opaque and one original OAe alpha call, no other native edits', () => {
  assert.equal(digest(stock), '866ba28ec676eb8702daa24a21aa64a75511a0973731d98a72aed891f26e8c8e');
  const result = patchBundle(stock, modulePath);
  assert.equal(result.split('await __vfMotion.render(').length, 2);
  assert.equal(result.split('await __vfMotion.renderOverlay(').length, 2);
  assert.equal(result.split('import*as __vfMotion from ').length, 2);
  const originalOverlay = extract(stock, 'async function OAe(', 'function t2n(');
  const patchedOverlay = extract(result, 'async function OAe(', 'function t2n(');
  const call = 'await e.frameshift.render(';
  const prefix = patchedOverlay.slice(patchedOverlay.indexOf('await __vfMotion.renderOverlay('),
    patchedOverlay.indexOf('{compositionHtml:t'));
  assert.equal(patchedOverlay.replace(prefix, call), originalOverlay);
  const originalOpaque = extract(stock, 'async function lUn(', 'async function cUn(');
  const patchedOpaque = extract(result, 'async function lUn(', 'async function cUn(');
  assert.equal(result.slice(result.indexOf('\n') + 1).replace(patchedOverlay, originalOverlay)
    .replace(patchedOpaque, originalOpaque), stock);
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'],
    {input: result, encoding: 'utf8', windowsHide: true});
  assert.equal(check.status, 0, check.stderr);
});

test('cold installer is strictly idempotent', () => {
  const once = patchBundle(stock, modulePath);
  assert.equal(patchBundle(once, modulePath), once);
});

test('exact existing Home queue lease metadata upgrades without weakening native lease guards', () => {
  const installed=patchBundle(stock,modulePath);
  const native='y={lane:i,jobId:e,resourceKey:o,priority:g,boosted:!!b?.boosted,';
  const owned='y={lane:i,jobId:e,resourceKey:o,priority:g,boosted:b?.homeScope||!!b?.boosted,';
  const source=installed.replace(native,owned)+'\n/* vf-custom:independent-home-queue-v5 */';
  assert.equal(patchBundle(source,modulePath),source);
  assert.throws(()=>patchBundle(source.replace('/* vf-custom:independent-home-queue-v5 */',''),modulePath),/lease anchors/);
  assert.throws(()=>patchBundle(source.replace('released:!1}', 'released:!0}'),modulePath),/lease anchors/);
});

test('exact earlier opaque-only installation upgrades once', () => {
  const anchor = 'await t.render({compositionHtml:Pxe(n.html,o)';
  const replacement = 'await __vfMotion.render(t.render.bind(t),{jobId:r,licensedJobId:RU(),getScope:()=>fhe.getStore(),lane:mF("frameshift"),checkAbort:()=>jp.get(r)?.checkAbort?.(),isAborted:()=>e.isJobAborted(r),outerSignal:Xl(),duration:o},{compositionHtml:Pxe(n.html,o)';
  const legacy = 'import*as __vfMotion from ' + JSON.stringify(modulePath) + ';\n' + stock.replace(anchor, replacement);
  const upgraded = patchBundle(legacy, modulePath);
  assert.equal(upgraded, patchBundle(stock, modulePath));
  assert.equal(patchBundle(upgraded, modulePath), upgraded);
});

test('stock hash, namespace, module and installed callsite drift all fail closed', () => {
  const installed = patchBundle(stock, modulePath);
  for (const source of [stock + '\n', stock.replace('format:"mov"', 'format:"mp4"'),
    installed.replace('renderOverlay(', 'renderOverlayOther('),
    installed.replace('kind:"frameshift-alpha-v1"', 'kind:"other"'),
    installed.replace('fps:ite', 'fps:25'), installed.replace('__vfMotion.render(', '__vfMotion.other(')]) {
    assert.throws(() => patchBundle(source, modulePath), /changed|drift|boundary|hash/i);
  }
  assert.throws(() => patchBundle(installed, './other.mjs'), /changed|drift|boundary|hash/i);
});

test('installed native license, ALS, cancel and lane anchors remain mandatory', () => {
  const installed = patchBundle(stock, modulePath);
  for (const [from, to] of [
    ['function RU(){return Jbr.getStore()?.jobId||null}', 'function RU(){return "job"}'],
    ['Xl=()=>cbr.getStore()', 'Xl=()=>null'], ['fhe=new $Pr', 'fhe=new Map'],
    ['jp=new Map', 'jp=otherJobs'], ['isJobAborted:Cbi', 'isJobAborted:()=>false'],
    ['signal:a,parked:!1,released:!1}', 'signal:a,parked:!0,released:!1}'],
    ['function mF(e){return e==="fflow"?"ffmpeg":V0i.has(e)?"render":e}', 'function mF(e){return e}'],
  ]) {
    assert.throws(() => patchBundle(installed.replace(from, to), modulePath), /anchor|changed|drift/i);
  }
});

test('already-patched bundle preserves independent hooks outside both guarded renderer bodies', () => {
  const independent = '/* independent existing custom hook */\n';
  const installed = independent + patchBundle(stock, modulePath) + independent;
  assert.equal(patchBundle(installed, modulePath), installed);
  const overlay = extract(stock, 'async function OAe(', 'function t2n(');
  const fullOverlay = extract(installed, 'async function OAe(', 'function t2n(');
  const legacy = installed.replace(fullOverlay, overlay);
  assert.equal(patchBundle(legacy, modulePath), installed);
  assert.throws(() => patchBundle(legacy.replace('format:"mov"', 'format:"mp4"'), modulePath), /changed|drift|boundary|hash/i);
});

const helper = new URL('../helpers/graphics-install.mjs', import.meta.url);
const mapSource = 'import { renderMapOffload } from "./hook.mjs";\nfunction render(){return renderMapOffload(renderCartograph,{});}';
function helperFixture(source, map = mapSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-alpha-install-'));
  const bundle = path.join(dir, 'index.mjs'), mapFile = path.join(dir, 'map.js');
  fs.writeFileSync(bundle, source);
  fs.writeFileSync(mapFile, map);
  return {bundle, mapFile, run: () => spawnSync(process.execPath, [fileURLToPath(helper), bundle, mapFile],
    {encoding: 'utf8', windowsHide: true}), cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

test('real graphics CLI installs cold, upgrades import-present legacy and reruns without duplication', () => {
  const full = patchBundle(stock, modulePath);
  const nativeOverlay = extract(stock, 'async function OAe(', 'function t2n(');
  const boundOverlay = extract(full, 'async function OAe(', 'function t2n(');
  for (const source of [stock, full.replace(boundOverlay, nativeOverlay), full]) {
    const f = helperFixture(source);
    try {
      let result = f.run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(f.bundle, 'utf8'), full);
      result = f.run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(f.bundle, 'utf8'), full);
      assert.equal(fs.readFileSync(f.mapFile, 'utf8'), mapSource);
    } finally { f.cleanup(); }
  }
});

test('graphics CLI rejects drift without touching either input, including map failure during upgrade', () => {
  const full = patchBundle(stock, modulePath);
  const nativeOverlay = extract(stock, 'async function OAe(', 'function t2n(');
  const boundOverlay = extract(full, 'async function OAe(', 'function t2n(');
  for (const [source, map] of [[full.replace('kind:"frameshift-alpha-v1"', 'kind:"other"'), mapSource],
    [full.replace(boundOverlay, nativeOverlay), mapSource.replace('return renderMapOffload(', 'return other(')]]) {
    const f = helperFixture(source, map);
    try {
      assert.notEqual(f.run().status, 0);
      assert.equal(fs.readFileSync(f.bundle, 'utf8'), source);
      assert.equal(fs.readFileSync(f.mapFile, 'utf8'), map);
    } finally { f.cleanup(); }
  }
});

test('exact patched OAe executes only inside caller lease and preserves every native option and return path', async () => {
  const source = patchBundle(stock, modulePath);
  const als = new AsyncLocalStorage();
  const signal = new AbortController().signal;
  const scheduler = extract(stock, 'async function ghe(', 'function Sbi(');
  const grantStart = scheduler.indexOf('y={lane:i,jobId:e,'), grantEnd = scheduler.indexOf('released:!1}', grantStart);
  assert.ok(grantStart >= 0 && grantEnd > grantStart);
  const lease = vm.runInNewContext('(' + scheduler.slice(grantStart + 2, grantEnd + 'released:!1}'.length) + ')',
    {i: 'render', e: 'job', o: 'frameshift', g: 'priority', b: {}, h: {}, a: signal});
  const scope = {jobId: 'job', lanes: new Set(['render']), leases: new Map([['render', lease]])};
  let context, received, receiver, checks = 0, schedulerCalls = 0;
  const provider = {render(options) { receiver = this; received = options; return {ignored: true}; }};
  const env = {_qe: {mkdirSync() {}}, $Ae: path, e2n: () => [{filename: 'font.woff2', localPath: 'font'}],
    ite: 24, Apa: '1920x1080', vpa: 300000, RU: () => 'job', fhe: als, mF: () => 'render',
    jp: new Map([['job', {checkAbort() { checks++; }}]]),
    Me: {isJobAborted: () => false, run() { schedulerCalls++; throw Error('must not acquire another lease'); }},
    Xl: () => signal, __vfMotion: {renderOverlay: async (native, ctx, options) => {
      context = ctx;
      assert.equal(als.getStore(), scope);
      return native(options);
    }}};
  const oa = vm.runInNewContext('(' + extract(source, 'async function OAe(', 'function t2n(') + ')', env);
  const za = vm.runInNewContext('(' + extract(stock, 'function Za(', 'function N2n(') + ')',
    {U: (n, digits = 2) => Number(n).toFixed(digits), Xy: 1920, cb: 1080, hfa: ''});
  const markup = za({durationSec: 3.294, body: '<p>Original</p>'});
  assert.ok(markup.includes('data-duration="3.29"'));
  const extra = {filename: 'hero.png', localPath: 'hero'};
  const output = await als.run(scope, () => oa({providers: {frameshift: provider}, html: markup,
    movPath: 'ORIGINAL.mov', workDir: 'original-work', extraAssets: [extra], signal,
    timeoutMs: 123456, renderTuning: {workers: 3, quality: 'high'}}));
  assert.equal(output, 'ORIGINAL.mov');
  assert.equal(receiver, provider);
  assert.equal(received.compositionHtml, markup);
  assert.equal(received.assets.length, 2);
  assert.equal(received.assets[1], extra);
  assert.equal(received.fps, 24);
  assert.equal(received.resolution, '1920x1080');
  assert.equal(received.format, 'mov');
  assert.equal(received.targetPath, output);
  assert.equal(received.workDir, path.join('original-work', 'frameshift'));
  assert.equal(received.timeoutMs, 123456);
  assert.equal(received.signal, signal);
  assert.equal(received.workers, 3);
  assert.equal(received.quality, 'high');
  assert.equal(context.kind, 'frameshift-alpha-v1');
  assert.equal(context.jobId, 'job');
  assert.equal(context.licensedJobId, 'job');
  assert.equal(context.getLicensedJobId(), 'job');
  assert.equal(context.getScope(), undefined);
  assert.equal(context.outerSignal, signal);
  assert.equal(context.lane, 'render');
  als.run(scope, () => context.checkAbort());
  assert.equal(checks, 1);
  assert.equal(context.isAborted(), false);
  assert.equal(schedulerCalls, 0);

  // Execute the exact stock-generated header and context through the real binding, not just the spy.
  let remote = 0;
  env.e2n = () => [];
  env.__vfMotion.renderOverlay = renderOverlay;
  configureMotion({getSettings: () => ({homeMotion: true}), getToken: () => 'test',
    endpoint: 'http://127.0.0.1:1', contract: 'stock-oa-test',
    fetchImpl: async () => { remote++; throw Error('offline'); }});
  try {
    const input = {providers: {frameshift: provider}, html: za({durationSec: 3.4}),
      movPath: path.join(os.tmpdir(), 'vf-oa-native-unused.mov'), workDir: os.tmpdir(), signal};
    assert.equal(await als.run(scope, () => oa(input)), input.movPath);
    assert.equal(remote, 1);
    assert.equal(received.compositionHtml, input.html);
    assert.equal(received.format, 'mov');
    assert.equal(schedulerCalls, 0);
    remote = 0;
    assert.equal(await oa(input), input.movPath);
    assert.equal(remote, 0, 'OAe callers which acquire their lease only inside the provider must remain native');
  } finally { configureMotion(null); }
});
