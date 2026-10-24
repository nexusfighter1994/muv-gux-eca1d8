import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {callbacks, loadClassifiers, verify} from '../update-tools/verify-home-callbacks.mjs';
import motion from '../node/home-motion-dispatch.cjs';
import {installHomeLibraryTrim} from '../node/home-library-trim.mjs';
const accepts = await loadClassifiers(fileURLToPath(new URL('../node/', import.meta.url)));
for (const [i, {family, body}] of callbacks.entries()) {
  test(`current native callback ${i}: ${family} remains independently eligible`, () => {
    assert.equal(accepts[family](body), true);
    assert.equal(accepts[family](body + ';otherWork()'), false);
  });
}
test('opaque Motion mock and validation/unknown callbacks stay server-only', () => {
  assert.equal(motion.renderOnly(callbacks.find(r => r.family === 'motion-opaque').body, true), false);
  for (const body of ['()=>N.validate($)', '()=>unknown.render($)', '()=>N.render(other)', '()=>ocr()']) {
    assert.equal(motion.renderOnly(body, false), false);
  }
});
test('native library preparation retains callback and counted trim scope', () => {
  const body = callbacks.find(r => r.family === 'library-trim').body;
  const calls = [], scope = {candidate: true, kind: 'video-normalize'};
  const scheduler = {run(...args) {calls.push(args);}};
  let sampler = () => ({run: callback => callback, finish() {}});
  installHomeLibraryTrim({scheduler, getSlotMeasurer: () => sampler, setSlotMeasurer: v => {sampler = v;},
    getContext: () => ({leases: new Map([['ffmpeg', {boosted: scope}]])})});
  scheduler.run('job', 'ffmpeg', body, {segmentType: 'b_roll_video'});
  assert.equal(calls[0][2], body);
  assert.equal(calls[0][3].homeKind, 'video-trim');
  assert.equal(sampler({resourceKey: 'ffmpegHome'}).run(body), body);
  assert.deepEqual(scope, {candidate: false, kind: 'video-trim'});
});
test('build contract rejects missing, duplicate and unrecognized native callbacks', () => {
  const bundle = callbacks.map(r => r.body).join('\n');
  assert.equal(verify(bundle, accepts).ok, true);
  assert.throws(() => verify(bundle.slice(callbacks[0].body.length), accepts), /changed or duplicated/);
  assert.throws(() => verify(bundle + callbacks[0].body, accepts), /changed or duplicated/);
  assert.throws(() => verify(bundle, {...accepts, normalize: () => false}), /miss Home admission/);
});
