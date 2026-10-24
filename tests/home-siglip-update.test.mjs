import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isHomeSiglipEmbedCallback, installHomeSiglipAdmission} from '../node/home-siglip.mjs';

const callbacks = JSON.parse(fs.readFileSync(new URL('./fixtures/siglip-callbacks-20261020.json', import.meta.url)));
test('all three native 2026.10.19.7 embeddings use independent Home admission', () => {
  for (const body of callbacks) assert.equal(isHomeSiglipEmbedCallback(body), true, body);
});
test('current upstream OCR and modified embeddings remain server-only', () => {
  for (const body of callbacks) {
    assert.equal(isHomeSiglipEmbedCallback(body.replace('negativeQueries:', 'unknownQueries:')), false);
    assert.equal(isHomeSiglipEmbedCallback(body + ';otherWork()'), false);
  }
  assert.equal(isHomeSiglipEmbedCallback('()=>(s.ocr||Ixe)({images:[],recognize:!0,maxSide:480})'), false);
});
test('real scheduler classification forwards exact current callbacks and preserves recovery', () => {
  const calls = [], scheduler = {run(...args) { calls.push(args); }, stats: () => ({}), isJobAborted: () => false};
  const state = {waiters: [], activeTotal: 0, activeByResource: new Map()};
  let admission = () => {}, release = () => {}, sampler = () => {};
  installHomeSiglipAdmission({scheduler, getState: () => state, getContext: () => null, claim() {},
    getAdmission: () => admission, setAdmission: v => {admission = v;},
    getRelease: () => release, setRelease: v => {release = v;},
    getSlotMeasurer: () => sampler, setSlotMeasurer: v => {sampler = v;},
    runIndependent: fn => fn(), runNativeContext: (scope, fn) => fn(),
    getCapacity: () => 20, schedule: () => ({unref() {}})});
  try {
    for (const body of callbacks) scheduler.run('job', 'siglip', body, {segmentType: 'b_roll_video'});
    scheduler.run('job', 'siglip', '()=>ocr()', {});
    scheduler.run('job', 'siglip', callbacks[0], {homeKind: 'siglip-native-recovery'});
    assert.deepEqual(calls.map(x => x[3].homeKind),
      ['siglip-home', 'siglip-home', 'siglip-home', 'siglip-server', 'siglip-native-recovery']);
    assert.equal(calls[0][2], callbacks[0]);
  } finally {
    for (const key of ['Queue','Scope','AttachSignal','Recovery','Buffers']) delete globalThis['__vfHomeSiglip' + key];
  }
});
