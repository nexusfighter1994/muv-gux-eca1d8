'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../node/oversize-chunk.cjs');

const segs = (n, d = 4.12) => Array.from({ length: n }, (_, i) => ({ outputSource: `/p/seg_${i + 1}.mp4`, duration_sec: d + (i % 3) * 0.04 }));
const sum = a => a.reduce((s, x) => s + x, 0);

test('planParts: 216 segments -> 8 even parts, contiguous frame-aligned windows that add up to the chunk', () => {
  const segments = segs(216);
  const total = sum(segments.map(s => s.duration_sec));
  const parts = M.planParts({ segments, transitions: [], totalSec: total, partSegments: 30, fps: 24 });
  assert.strictEqual(parts.length, 8);
  assert.deepStrictEqual(parts.map(p => p.to - p.from), [27, 27, 27, 27, 27, 27, 27, 27]);
  assert.strictEqual(parts[0].from, 0); assert.strictEqual(parts[7].to, 216);
  for (let k = 1; k < parts.length; k += 1) {
    assert.strictEqual(parts[k].from, parts[k - 1].to);
    assert.ok(Math.abs(parts[k].startSec - (parts[k - 1].startSec + parts[k - 1].durationSec)) < 1e-9);
    assert.ok(Math.abs(parts[k].startSec * 24 - Math.round(parts[k].startSec * 24)) < 1e-9, 'window starts on a frame');
  }
  assert.ok(Math.abs(sum(parts.map(p => p.durationSec)) - total) < 1e-6);
});

test('planParts: uneven counts spread the remainder; small chunk stays one part', () => {
  assert.deepStrictEqual(M.planParts({ segments: segs(64), totalSec: 270, partSegments: 30 }).map(p => p.to - p.from), [22, 21, 21]);
  assert.strictEqual(M.planParts({ segments: segs(6), totalSec: 25, partSegments: 30 }).length, 1);
  assert.throws(() => M.planParts({ segments: [{ duration_sec: 0 }], totalSec: 5 }), /no duration/);
});

test('planParts: transitions inside a part are re-indexed, the one at a part boundary is dropped', () => {
  const segments = segs(60, 4);
  const transitions = [{ after_segment: 5, style: 'dissolve', duration_frames: 8 }, { after_segment: 30, style: 'crossfade' },
    { after: 31, style: 'dissolve' }, { after_segment: 59, style: 'crossfade', duration_frames: 12 }, { after_segment: 60, style: 'x' }];
  const parts = M.planParts({ segments, transitions: { transitions }, totalSec: 240, partSegments: 30 });
  assert.strictEqual(parts.length, 2);
  assert.deepStrictEqual(parts[0].transitions, [{ after_segment: 5, style: 'dissolve', duration_frames: 8 }]);
  assert.deepStrictEqual(parts[1].transitions, [{ style: 'dissolve', after_segment: 1 }, { after_segment: 29, style: 'crossfade', duration_frames: 12 }]);
});

test('mapSegments matches the app mapping (audio rules, polish effects and fill)', () => {
  const o = M.createOversizeChunk({ buildPayload: x => x, renderPart: async () => {}, basePath: () => '', tmpPath: p => p, finish: async () => {} });
  const polish = new Map([['s2', { effects: [{ type: 'zoom' }], fill: { mode: 'blur' } }]]);
  const out = o.mapSegments([
    { id: 's2', segment_id: 2, type: 'b_roll_video', outputPath: '/b.mp4', duration_sec: 4 },
    { id: 's1', segment_id: 1, type: 'b_roll_video_audio', finalType: 'b_roll_video_audio', audio_json: '{"include":true,"volume":0.5}', outputPath: '/a.mp4', duration_sec: 3 },
    { id: 's3', segment_id: 3, type: 'b_roll_video_audio', finalType: 'b_roll_image', audio_json: '{"include":true}', outputPath: '/c.mp4', duration_sec: 5 },
    { id: 's4', segment_id: 4, type: 'map_3d', audio_json: 'broken', outputPath: '/d.mp4', duration_sec: 6 }], polish);
  assert.deepStrictEqual(out, [
    { type: 'video', outputSource: '/a.mp4', duration_sec: 3, audio: { include: true, volume: 0.5, muteVoiceover: true } },
    { type: 'video', outputSource: '/b.mp4', duration_sec: 4, effects: [{ type: 'zoom' }], fill: { mode: 'blur' } },
    { type: 'video', outputSource: '/c.mp4', duration_sec: 5 },
    { type: 'video', outputSource: '/d.mp4', duration_sec: 6 }]);
});

test('shouldSplit: only real, oversize chunks; knob can switch it off', () => {
  const mk = (cfg, mock = false) => M.createOversizeChunk({ buildPayload: x => x, renderPart: async () => {}, basePath: () => '', tmpPath: p => p, finish: async () => {},
    isMock: () => mock, settings: () => ({ ...M.DEFAULTS, ...cfg }) });
  const big = { segmentResults: new Array(41).fill({}) }, small = { segmentResults: new Array(40).fill({}) };
  assert.strictEqual(mk({}).shouldSplit(big), true);
  assert.strictEqual(mk({}).shouldSplit(small), false);
  assert.strictEqual(mk({ enabled: false }).shouldSplit(big), false);
  assert.strictEqual(mk({}, true).shouldSplit(big), false);
  assert.strictEqual(mk({}).shouldSplit({ ...big, deps: { renderChunk() {} } }), false);
  assert.strictEqual(mk({}).shouldSplit(null), false);
  assert.deepStrictEqual(M.readKnob('x', () => '{"enabled":false,"splitAbove":60,"partSegments":999}'), { enabled: false, splitAbove: 60, partSegments: 30, fps: 24 });
  assert.deepStrictEqual(M.readKnob('x', () => { throw new Error('none'); }), M.DEFAULTS);
});

function harness(tmp, { failPart = 0, wrongDuration = false } = {}) {
  const calls = { ffmpeg: [], payloads: [], rendered: [], finished: [] };
  const durations = new Map();
  const execFile = (file, args, opts, cb) => {
    try {
      const last = args[args.length - 1];
      if (file === 'ffprobe') {
        if (args.includes('-count_packets')) return cb(null, `${Math.round((durations.get(last) ?? 0) * 24)}\n`, '');
        if (args.includes('stream=bit_rate')) return cb(null, '189431\n', '');
        return cb(null, `${durations.get(last) ?? 0}\n`, '');
      }
      calls.ffmpeg.push(args);
      const input = args[args.indexOf('-i') + 1];
      if (last.endsWith('.wav')) { fs.writeFileSync(last, 'wav'); durations.set(last, Number(args[args.indexOf('-t') + 1])); }
      else if (input.endsWith('.txt')) {
        const list = fs.readFileSync(input, 'utf8').trim().split('\n').filter(l => l.startsWith('duration ')).map(l => Number(l.slice(9)));
        fs.writeFileSync(last, 'video'); durations.set(last, list.reduce((x, d) => x + d, 0));
      } else { fs.writeFileSync(last, 'joined'); durations.set(last, durations.get(input)); }
      cb(null, '', '');
    } catch (e) { cb(e, '', String(e)); }
  };
  const o = M.createOversizeChunk({
    buildPayload: a => { calls.payloads.push(a); return { built: a.filename, n: a.segments.length, vo: a.voiceoverSource, d: a.voiceoverDurationSec }; },
    renderPart: async a => {
      calls.rendered.push(a);
      if (calls.rendered.length === failPart) throw new Error('boom');
      fs.writeFileSync(a.targetPath, 'part'); durations.set(a.targetPath, wrongDuration ? a.contentSeconds + 3 : a.contentSeconds);
    },
    basePath: (slug, n) => path.join(tmp, slug, `chunk_${n}.base.mp4`), tmpPath: p => `${p}.tmp`,
    finish: async (t, f) => { fs.renameSync(t, f); calls.finished.push(f); return f; },
    settings: () => ({ ...M.DEFAULTS, partSegments: 30 }), execFile, log: () => {} });
  return { o, calls };
}

const chunkArgs = (n = 64) => {
  const segmentResults = Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, segment_id: i + 1, type: 'b_roll_video', outputPath: `/p/s${i + 1}.mp4`, duration_sec: 4 }));
  return { jobId: '43a0317f-x', slug: 'v', chunkNumber: 185, row: { id: 'c185', voiceover_path: '/p/voiceover.mp3', duration_s: n * 4 },
    segmentResults, transitions: [{ after_segment: 2, style: 'dissolve' }], motionBlur: true, outputQuality: 'fast' };
};

test('render: parts get their voiceover slice and payload, are joined, and the work dir is removed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovc-')); fs.mkdirSync(path.join(tmp, 'v'));
  const { o, calls } = harness(tmp);
  const result = await o.render(chunkArgs(64));
  assert.strictEqual(result, path.join(tmp, 'v', 'chunk_185.base.mp4'));
  assert.strictEqual(fs.readFileSync(result, 'utf8'), 'joined');
  assert.deepStrictEqual(calls.payloads.map(p => p.segments.length), [22, 21, 21]);
  assert.deepStrictEqual(calls.payloads.map(p => p.voiceoverDurationSec), [88, 84, 84]);
  assert.deepStrictEqual(calls.payloads[0].transitions, [{ after_segment: 2, style: 'dissolve' }]);
  assert.strictEqual(calls.payloads[1].filename, 'chunk_185_part2.mp4');
  assert.strictEqual(calls.payloads[0].motionBlur, true); assert.strictEqual(calls.payloads[0].outputQuality, 'fast');
  const cut = calls.ffmpeg.filter(a => a[a.length - 1].endsWith('.wav') && a.includes('-ss'));
  assert.deepStrictEqual(cut.map(a => [a[a.indexOf('-ss') + 1], a[a.indexOf('-t') + 1]]), [['0.000000', '88.000000'], ['88.000000', '84.000000'], ['172.000000', '84.000000']]);
  assert.ok(cut[0].includes('-f') && cut[0][cut[0].indexOf('-f') + 1] === 'mp3', 'mp3 demuxer is forced');
  assert.deepStrictEqual(calls.rendered.map(r => [r.chunkId, r.contentSeconds, r.jobId]), [['c185', 88, '43a0317f-x'], ['c185', 84, '43a0317f-x'], ['c185', 84, '43a0317f-x']]);
  const join = calls.ffmpeg[calls.ffmpeg.length - 1];
  assert.ok(join.includes('-video_track_timescale') && join[join.indexOf('-video_track_timescale') + 1] === '12288');
  assert.strictEqual(join[join.indexOf('-b:a') + 1], '192k', 'audio bitrate follows the parts (189 kbit -> 192k)');
  assert.deepStrictEqual([o.stats.last.frames, o.stats.last.joinedSec], [64 * 4 * 24, 256]);
  assert.strictEqual(fs.existsSync(`${result}.parts`), false);
  assert.deepStrictEqual([o.stats.chunks, o.stats.parts, o.stats.failed, o.stats.last.parts], [1, 3, 0, 3]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('render: a failed part keeps the finished ones; the retry renders only what is missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovc-')); fs.mkdirSync(path.join(tmp, 'v'));
  const first = harness(tmp, { failPart: 2 });
  await assert.rejects(first.o.render(chunkArgs(64)), /boom/);
  assert.strictEqual(first.o.stats.failed, 1);
  assert.strictEqual(fs.existsSync(path.join(tmp, 'v', 'chunk_185.base.mp4')), false);
  const kept = fs.readdirSync(path.join(tmp, 'v', 'chunk_185.base.mp4.parts')).filter(f => f.endsWith('.ok'));
  assert.strictEqual(kept.length, 1);
  const second = harness(tmp);
  // the second harness has no duration table for the kept part; give it one through a first probe-free reuse
  const origRender = second.o.render;
  await assert.rejects(origRender(chunkArgs(64)), /no video frames/);   // the kept part has no duration in this second fake -> join refuses
  assert.strictEqual(second.calls.rendered.length, 2, 'only parts 2 and 3 were rendered again');
  assert.strictEqual(second.o.stats.reused, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('render: a part with the wrong duration is rejected', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovc-')); fs.mkdirSync(path.join(tmp, 'v'));
  const { o } = harness(tmp, { wrongDuration: true });
  await assert.rejects(o.render(chunkArgs(64)), /part 1 is 91\.00 s, expected 88\.00 s/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
