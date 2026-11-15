'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const probeModule = require(process.env.AP_MODULE || '../node/artifact-probe.cjs');

// the native function, verbatim from the bundle, to compare results
function native(io) {
  return async function yZi(e){try{let{stdout:t}=await io(["-v","error","-show_entries","format=duration:stream=codec_type,width,height","-of","json",e],{timeoutMs:3e4}),r=JSON.parse(t||"{}"),n=Number(r?.format?.duration),o=(r?.streams||[]).find(i=>i.codec_type==="video");return{valid:!!o,durationSec:Number.isFinite(n)?n:null,width:Number(o?.width)||null,height:Number(o?.height)||null}}catch{return{valid:!1,durationSec:null,width:null,height:null}}};
}

const outputs = [
  JSON.stringify({ streams: [{ codec_type: 'video', width: 1920, height: 1080 }], format: { duration: '4.875000' } }),
  JSON.stringify({ streams: [{ codec_type: 'video', width: 1024, height: 1536 }], format: {} }),
  JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '3.2' } }),
  JSON.stringify({ streams: [], format: { duration: 'N/A' } }),
  '', 'not json',
];

test('same result as the native probe for every kind of ffprobe output', async () => {
  for (const stdout of outputs) {
    const io = async () => ({ stdout });
    assert.deepEqual(await probeModule.create({ io })('/x'), await native(io)('/x'), stdout.slice(0, 40));
  }
});

test('a failing or timed out ffprobe gives the same "invalid" answer, never an exception', async () => {
  const io = async () => { throw Object.assign(Error('timed out'), { code: 'FFMPEG_TIMEOUT' }); };
  assert.deepEqual(await probeModule.create({ io })('/x'), { valid: false, durationSec: null, width: null, height: null });
  assert.deepEqual(await probeModule.create({ io })('/x'), await native(io)('/x'));
});

test('same ffprobe arguments, 180 s instead of 30 s', async () => {
  const calls = [];
  const io = async (args, options) => { calls.push([args, options]); return { stdout: outputs[0] }; };
  await probeModule.create({ io })('/data/projects/a/b.png');
  await native(io)('/data/projects/a/b.png');
  assert.deepEqual(calls[0][0], calls[1][0]);
  assert.deepEqual(calls[0][1], { timeoutMs: 180000 });
  assert.deepEqual(calls[1][1], { timeoutMs: 30000 });
  const custom = probeModule.create({ io, timeoutMs: 60000 });
  await custom('/x');
  assert.deepEqual(calls[2][1], { timeoutMs: 60000 });
  assert.equal(custom.timeoutMs, 60000);
  assert.equal(custom.__vfProbeTimeout, 'artifact-probe-timeout-v1');
});

test('bad arguments are refused', () => {
  assert.throws(() => probeModule.create({}), TypeError);
  assert.throws(() => probeModule.create({ io: async () => ({}), timeoutMs: 1000 }), RangeError);
  assert.throws(() => probeModule.create({ io: async () => ({}), timeoutMs: 1e9 }), RangeError);
});
