const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCopy } = require('../node/validate-copy.cjs');

function media(frames = 240, duration = 10) {
  return {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1920, height: 1080, r_frame_rate: '24/1', avg_frame_rate: '24/1', time_base: '1/12288', start_time: '0', duration: String(duration), nb_frames: String(frames) },
      { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', time_base: '1/48000', start_time: '0', duration: String(duration) },
    ],
    format: { start_time: '0', duration: String(duration) },
  };
}
function pair() { return { inputs: [media(), media()], output: media(480, 20) }; }
function check(mutator, reason) {
  const fixture = pair(); mutator(fixture);
  const result = validateCopy(fixture.inputs, fixture.output);
  assert.equal(result.ok, false, JSON.stringify(result));
  if (reason) assert.equal(result.reason, reason, JSON.stringify(result));
}

test('complete homogeneous metadata passes without optional audio counts', () => {
  const { inputs, output } = pair();
  const before = JSON.stringify({ inputs, output });
  const result = validateCopy(inputs, output);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.details.expectedVideoFrames, 480);
  assert.equal(result.details.audioCountCheck, 'unavailable');
  assert.equal(JSON.stringify({ inputs, output }), before);
});

test('native strict regression: aggregate-real-values synthetic copy can conserve frames despite 83.646ms drift', () => {
  const inputs = Array.from({ length: 170 }, (_, i) => {
    const count = 705 + (i < 8 ? 1 : 0);
    const m = media(count, count / 24);
    m.format.duration = String(count / 24 + (4995.054667 - 119858 / 24) / 170);
    m.streams[1].duration = String(count / 24 + (4995.031 - 119858 / 24) / 170);
    return m;
  });
  const output = media(119858, 4994.971354);
  output.format.duration = '4995.054667';
  output.streams[1].duration = '4995.031';
  output.streams[0].avg_frame_rate = '1472815104/61378208';
  assert.ok(4995.055 - 4994.971354 > 1.5 / 24);
  const result = validateCopy(inputs, output);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.details.envelopeSeconds <= 2 * 1024 / 48000 + 1 / 24 + 1e-9);
});

test('missing video frame rejects even when all durations remain identical', () => check(f => { f.output.streams[0].nb_frames = '479'; }, 'video_frame_count_mismatch'));
test('extra video frame rejects', () => check(f => { f.output.streams[0].nb_frames = '481'; }, 'video_frame_count_mismatch'));
test('nominal rate required but average rate may differ', () => {
  const f = pair(); f.output.streams[0].avg_frame_rate = '23999/1000';
  assert.equal(validateCopy(f.inputs, f.output).ok, true);
  f.output.streams[0].r_frame_rate = '25/1';
  assert.equal(validateCopy(f.inputs, f.output).reason, 'video_signature_mismatch');
});
test('equivalent rational nominal rate and timebase accepted', () => {
  const f = pair(); f.output.streams[0].r_frame_rate = '48/2'; f.output.streams[0].time_base = '2/24576';
  assert.equal(validateCopy(f.inputs, f.output).ok, true);
});

for (const [field, value] of [['profile', 'Main'], ['pix_fmt', 'yuv422p'], ['width', 1280], ['height', 720], ['time_base', '1/90000'], ['codec_name', 'hevc']]) {
  test('reject incompatible video ' + field, () => check(f => { f.inputs[1].streams[0][field] = value; }));
}
for (const field of ['profile', 'pix_fmt', 'width', 'height', 'r_frame_rate', 'time_base', 'start_time', 'duration', 'nb_frames']) {
  test('reject missing video metadata ' + field, () => check(f => { delete f.inputs[0].streams[0][field]; }));
}
for (const value of ['N/A', '0', '-1', '', null, '240oops', '1.5', '9007199254740992']) {
  test('reject invalid nb_frames ' + JSON.stringify(value), () => check(f => { f.inputs[0].streams[0].nb_frames = value; }));
}
for (const value of ['N/A', '0', '-1', '', null, '10oops', Infinity]) {
  test('reject invalid duration ' + JSON.stringify(value), () => check(f => { f.output.format.duration = value; }));
}
test('missing output nb_frames rejects', () => check(f => { delete f.output.streams[0].nb_frames; }));
test('output video start outside one nominal frame rejects', () => check(f => { f.output.streams[0].start_time = '0.05'; }, 'output_start_not_near_zero'));
test('output format start outside one nominal frame rejects', () => check(f => { f.output.format.start_time = '-0.05'; }, 'output_start_not_near_zero'));
test('format truncation rejects even with exact nb_frames', () => check(f => { f.output.format.duration = '19.8'; }, 'format_duration_outside_envelope'));
test('format extension rejects even with exact nb_frames', () => check(f => { f.output.format.duration = '20.2'; }, 'format_duration_outside_envelope'));
test('video timeline truncation rejects even with exact nb_frames', () => check(f => { f.output.streams[0].duration = '19.8'; }, 'video_end_outside_envelope'));
test('audio layout mismatch rejects', () => check(f => { f.inputs[1].streams[1].channel_layout = 'mono'; }, 'audio_signature_mismatch'));
test('missing audio in one input rejects', () => check(f => { f.inputs[0].streams.pop(); }, 'audio_signature_mismatch'));
test('unexpected subtitle rejects', () => check(f => { f.output.streams.push({ codec_type: 'subtitle' }); }, 'unexpected_streams'));
test('extra video rejects', () => check(f => { f.output.streams.push({ ...f.output.streams[0] }); }, 'unexpected_streams'));
test('extra audio rejects', () => check(f => { f.output.streams.push({ ...f.output.streams[1] }); }, 'unexpected_streams'));
test('consistent video-only inputs can pass', () => {
  const f = pair(); [...f.inputs, f.output].forEach(m => m.streams.pop());
  assert.equal(validateCopy(f.inputs, f.output).ok, true);
});
test('exact counted AAC packet total checked when available', () => {
  const f = pair(); f.inputs.forEach(m => { m.streams[1].nb_read_packets = '470'; });
  f.output.streams[1].nb_read_packets = '940';
  assert.equal(validateCopy(f.inputs, f.output).ok, true);
  f.output.streams[1].nb_read_packets = '939';
  assert.equal(validateCopy(f.inputs, f.output).reason, 'audio_count_mismatch');
});
test('partial AAC packet counts are optional, never inferred', () => {
  const f = pair(); f.inputs[0].streams[1].nb_read_packets = '470';
  const result = validateCopy(f.inputs, f.output);
  assert.equal(result.ok, true); assert.equal(result.details.audioCountCheck, 'unavailable');
});
test('AAC metadata nb_frames conservatively checked when all supplied', () => {
  const f = pair(); f.inputs.forEach(m => { m.streams[1].nb_frames = '470'; }); f.output.streams[1].nb_frames = '939';
  assert.equal(validateCopy(f.inputs, f.output).reason, 'audio_count_mismatch');
});
test('tail envelope is global, never multiplied by input count', () => {
  const inputs = Array.from({ length: 170 }, () => media()); const output = media(40800, 1700.2);
  const result = validateCopy(inputs, output);
  assert.equal(result.ok, false); assert.ok(result.details.envelopeSeconds < 0.085);
});
test('reject malformed outer structures without throwing', () => {
  for (const inputs of [null, [], {}, [null]]) assert.equal(validateCopy(inputs, null).ok, false);
});
test('output profile mismatch rejects', () => check(f => { f.output.streams[0].profile = 'Main'; }, 'video_signature_mismatch'));
test('AAC HE profile cannot borrow the 1024-sample LC envelope', () => check(f => { f.output.streams[1].profile = 'HE-AAC'; }, 'unsupported_audio_codec'));
test('attached cover art is not a valid video stream', () => check(f => { f.output.streams[0].disposition = { attached_pic: 1 }; }, 'unexpected_streams'));
test('audio truncation rejects with preserved video', () => check(f => { f.output.streams[1].duration = '19'; }, 'audio_end_outside_envelope'));
test('missing audio duration rejects', () => check(f => { delete f.output.streams[1].duration; }, 'missing_metadata'));
test('exact envelope accepted, over-envelope rejected', () => {
  const f = pair(); const envelope = Math.max(2 / 24, 2 * 1024 / 48000 + 1 / 24);
  f.output.format.duration = String(20 + envelope);
  assert.equal(validateCopy(f.inputs, f.output).ok, true);
  f.output.format.duration = String(20 + envelope + 0.00001);
  assert.equal(validateCopy(f.inputs, f.output).reason, 'format_duration_outside_envelope');
});
test('impossible early-input stream end cannot hide behind valid final timeline', () => check(f => { f.inputs[0].streams[0].start_time = '-100'; }, 'invalid_stream_timeline'));
