'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
delete globalThis.__vfFxSmartBake;
const fx = require('../node/fx-smart-bake.cjs');

const packetsFor = (frames, gop = 48) => Array.from({ length: frames }, (_, i) => ({ pts: i * 512, dts: i * 512, key: i % gop === 0 }));

test('closedGopStarts accepts closed GOPs in decode order with B-frames', () => {
  // decode order I P B B | I P B: display 0 3 1 2 | 4 6 5
  const pts = [0, 3, 1, 2, 4, 6, 5];
  const packets = pts.map((p, i) => ({ pts: p, dts: i, key: p === 0 || p === 4 }));
  const { starts, rank } = fx.closedGopStarts(packets);
  assert.deepEqual(starts, [0, 4]);
  assert.deepEqual(rank, [0, 3, 1, 2, 4, 6, 5]);
});

test('closedGopStarts rejects an open GOP boundary', () => {
  // The second key frame (display 4) is followed in decode order by a frame shown before it.
  const pts = [0, 2, 1, 4, 3, 5];
  const packets = pts.map((p, i) => ({ pts: p, dts: i, key: p === 0 || p === 4 }));
  assert.deepEqual(fx.closedGopStarts(packets).starts, [0]);
});

test('encodeRanges covers each window with whole GOPs and merges neighbours', () => {
  const starts = [0, 48, 96, 144, 192];
  assert.deepEqual(fx.encodeRanges([{ start: 50, end: 58 }], starts, 230), [{ from: 48, to: 96 }]);
  assert.deepEqual(fx.encodeRanges([{ start: 46, end: 50 }], starts, 230), [{ from: 0, to: 96 }], 'window across a boundary');
  assert.deepEqual(fx.encodeRanges([{ start: 48, end: 96 }], starts, 230), [{ from: 48, to: 96 }], 'exact GOP stays one GOP');
  assert.deepEqual(fx.encodeRanges([{ start: 200, end: 208 }], starts, 230), [{ from: 192, to: 230 }], 'last GOP runs to the end');
  assert.deepEqual(fx.encodeRanges([{ start: 10, end: 12 }, { start: 50, end: 52 }, { start: 150, end: 152 }], starts, 230),
    [{ from: 0, to: 96 }, { from: 144, to: 192 }], 'adjacent GOPs merge');
  assert.throws(() => fx.encodeRanges([{ start: 5, end: 3 }], starts, 230), /invalid window/);
  assert.throws(() => fx.encodeRanges([{ start: 225, end: 240 }], starts, 230), /invalid window/);
  assert.throws(() => fx.encodeRanges([{ start: 5, end: 6 }], [48], 230), /closed GOP/);
});

test('planParts covers every frame exactly once', () => {
  const parts = fx.planParts([{ from: 48, to: 96 }, { from: 144, to: 192 }], 230);
  assert.deepEqual(parts.map(p => [p.kind, p.from, p.to]), [['copy', 0, 48], ['encode', 48, 96], ['copy', 96, 144], ['encode', 144, 192], ['copy', 192, 230]]);
  assert.deepEqual(fx.planParts([{ from: 0, to: 230 }], 230).map(p => p.kind), ['encode']);
});

test('seconds is exact and refuses inexact rates', () => {
  assert.equal(fx.seconds(96, { num: 24, den: 1 }), '4.000000');
  assert.equal(fx.seconds(50, { num: 25, den: 1 }), '2.000000');
  assert.throws(() => fx.seconds(49, { num: 30000, den: 1001 }), /exact timestamp/);
});

test('encodeArgsFor uses the native graph with shifted windows, seeks the input and drops audio', () => {
  let seen;
  const build = a => { seen = a; return ['-i', a.basePath, '-i', a.clipPath, '-filter_complex', 'G', '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '18', '-c:a', 'copy', a.outPath]; };
  const args = { basePath: 'b.mp4', clipPath: 'c.mp4', pieces: [{ start: 50, end: 58, offset: 8 }, { start: 150, end: 158, offset: 16 }], totalFrames: 230, width: 1920, height: 1080, encodeArgs: [], outPath: 'o.mp4' };
  const out = fx.encodeArgsFor(build, args, { from: 48, to: 96 }, { num: 24, den: 1 }, 'span.mp4');
  assert.deepEqual(seen.pieces, [{ start: 2, end: 10, offset: 8 }]);
  assert.equal(seen.totalFrames, 48);
  assert.deepEqual(out, ['-ss', '2.000000', '-i', 'b.mp4', '-i', 'c.mp4', '-filter_complex', 'G', '-map', '[v]', '-c:v', 'libx264', '-crf', '18', '-an', 'span.mp4']);
});

test('concatList quotes paths and sets exact copy bounds', () => {
  const parts = [{ kind: 'copy', from: 0, to: 48 }, { kind: 'encode', from: 48, to: 96, path: "/a/it's.mp4" }, { kind: 'copy', from: 96, to: 230 }];
  assert.equal(fx.concatList(parts, '/b.mp4', { num: 24, den: 1 }, 230),
    "ffconcat version 1.0\nfile '/b.mp4'\ninpoint 0.000000\noutpoint 2.000000\nfile '/a/it'\\''s.mp4'\nfile '/b.mp4'\ninpoint 4.000000\n");
});

test('verifyCopied compares non-key copied packets by display position', () => {
  const packets = packetsFor(96);
  const { rank } = fx.closedGopStarts(packets);
  const rows = packets.map((p, i) => ({ pts: p.pts, size: 10, hash: `h${i}` }));
  const parts = [{ kind: 'copy', from: 0, to: 48 }, { kind: 'encode', from: 48, to: 96 }];
  const out = rows.map((r, i) => (i === 0 || i >= 48 ? { ...r, hash: 'x' } : r));
  assert.equal(fx.verifyCopied(parts, packets, rows, out, rank), 47, 'key frame and encoded range are not compared');
  const bad = rows.map((r, i) => (i === 7 ? { ...r, hash: 'x' } : r));
  assert.throws(() => fx.verifyCopied(parts, packets, rows, bad, rank), /copied frame 7/);
  assert.throws(() => fx.verifyCopied(parts, packets, rows, rows.slice(1), rank), /packet count/);
});

test('enabled follows the runtime switch and defaults to on', () => {
  assert.equal(fx.enabled(1e9, () => '{"enabled":false}'), false);
  assert.equal(fx.enabled(1e9 + 1, () => { throw new Error('unused'); }), false, 'cached');
  assert.equal(fx.enabled(2e9, () => { throw new Error('no file'); }), true);
});

test('bakeChunk falls back to the native encode on any failure and cleans up', async () => {
  fx.enabled(3e9, () => '{}');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxsb-'));
  const outPath = path.join(dir, 'o.mp4');
  const calls = [];
  const ffmpeg = async a => { calls.push(a); if (a.includes('-ss')) throw new Error('boom'); return { stdout: '' }; };
  const build = a => ['FULL', a.outPath];
  const args = { basePath: path.join(dir, 'missing.mp4'), clipPath: 'c', pieces: [{ start: 2, end: 4, offset: 0 }], totalFrames: 96, width: 1, height: 1, encodeArgs: ['-r', '24/1'], outPath };
  await fx.bakeChunk({ buildFullArgs: build, args, ffmpeg, options: {} });
  assert.deepEqual(calls.at(-1), ['FULL', outPath], 'native encode ran');
  assert.ok(fx.stats.fallbacks >= 1);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bakeChunk rethrows an abort instead of re-encoding', async () => {
  const controller = new AbortController();
  controller.abort();
  const args = { basePath: '/nonexistent', clipPath: 'c', pieces: [{ start: 2, end: 4, offset: 0 }], totalFrames: 96, width: 1, height: 1, encodeArgs: ['-r', '24/1'], outPath: path.join(os.tmpdir(), 'fxsb-abort.mp4') };
  let full = 0;
  await assert.rejects(fx.bakeChunk({ buildFullArgs: a => { full++; return []; }, args, ffmpeg: async () => ({ stdout: '' }), options: { signal: controller.signal } }));
  assert.equal(full, 0);
});

test('bakeChunk skips the smart path when the switch is off', async () => {
  fx.enabled(4e9, () => '{"enabled":false}');
  const calls = [];
  await fx.bakeChunk({ buildFullArgs: () => ['FULL'], args: { outPath: 'x' }, ffmpeg: async a => { calls.push(a); return {}; }, options: {} });
  assert.deepEqual(calls, [['FULL']]);
  fx.enabled(5e9, () => '{}');
});
