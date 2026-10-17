import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompatibleConcat } from '../node/stream-compat.mjs';

test('disabled automatic conversion refuses known unsafe AVC before any encode or concat', async () => {
  let calls = 0;
  const wrap = createCompatibleConcat(() => { calls++; }, {
    convertUnsafe: false,
    probe: async () => JSON.stringify({streams:[{codec_type:'video',codec_name:'h264',
      profile:'High 4:4:4 Predictive',pix_fmt:'yuv420p'}]}),
    run: async () => { calls++; },
  });
  await assert.rejects(wrap({localPaths:['/does-not-exist.mp4']}), /automatic conversion is disabled/i);
  assert.equal(calls, 0);
});

test('disabled conversion keeps compatible original paths and return value', async () => {
  const args = {localPaths:['/compatible.mp4']};
  const wrap = createCompatibleConcat(input => { assert.deepEqual(input.localPaths, args.localPaths); return 'native'; }, {
    convertUnsafe: false,
    probe: async () => JSON.stringify({streams:[{codec_type:'video',codec_name:'h264',profile:'High',pix_fmt:'yuv420p'}]}),
    run: async () => { throw Error('Unexpected encode'); },
  });
  assert.equal(await wrap(args), 'native');
});
