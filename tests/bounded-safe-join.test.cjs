const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modulePath = path.join(__dirname, '../node/bounded-safe-join.cjs');
test('bounded assembly implementation exists', () => assert.ok(fs.existsSync(modulePath)));

if (fs.existsSync(modulePath)) {
  const { createSafeJoin } = require(modulePath);
  const media = (duration = 1) => ({ streams: [
    { codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 64,
      height: 64, r_frame_rate: '24/1', avg_frame_rate: '24/1', time_base: '1/12288',
      start_time: '0', duration: String(duration), nb_frames: String(duration * 24) },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2,
      channel_layout: 'stereo', time_base: '1/48000', start_time: '0', duration: String(duration) },
  ], format: { duration: String(duration), start_time: '0' } });
  function fixture(t, count = 20) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-join-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const infos = new Map(), paths = Array.from({ length: count }, (_, i) => path.join(root, `source-${i}.mp4`));
    for (const p of paths) { fs.writeFileSync(p, 'original'); infos.set(p, media()); }
    const target = path.join(root, 'final.mp4'); fs.writeFileSync(target, 'keep-until-success');
    let busy = 0, maximum = 0;
    const calls = [];
    async function run(args, options) {
      options.signal?.throwIfAborted(); calls.push(args); maximum = Math.max(maximum, ++busy);
      await new Promise(resolve => setTimeout(resolve, 1));
      const out = args.at(-1), concat = args.includes('concat');
      const info = media(concat ? count : 1);
      if (out.endsWith('.mov')) info.streams[1].codec_name = 'pcm_s24le';
      infos.set(out, info); fs.writeFileSync(out, 'rendered'); busy--;
    }
    const probe = async args => ({ code: 0, stdout: JSON.stringify(infos.get(args.at(-1))) });
    return { root, paths, target, calls, run, probe, infos, maximum: () => maximum };
  }
  test('170-input fallback never starts multiple decoders and encodes AAC only once', async t => {
    const f = fixture(t, 170);
    const join = createSafeJoin({ probe: f.probe, run: f.run, validateCopy: () => ({ ok: false, reason: 'fixture forces normalization' }) });
    const result = await join({ chunkPaths: f.paths, targetPath: f.target });
    assert.equal(result.method, 'bounded-reencode');
    assert.equal(f.maximum(), 1);
    assert.equal(f.calls.filter(a => a.includes('libx264')).length, 170);
    assert.equal(f.calls.filter(a => a.includes('aac')).length, 1);
    for (const args of f.calls) assert.equal(args.filter(v => v === '-i').length, 1);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'rendered');
    assert.ok(f.paths.every(p => fs.readFileSync(p, 'utf8') === 'original'));
    assert.deepEqual(fs.readdirSync(f.root).filter(p => p.startsWith('.vf-safe-join-')), []);
  });
  test('proven copy bypasses all encodes', async t => {
    const f = fixture(t);
    const result = await createSafeJoin({ probe: f.probe, run: f.run, validateCopy: () => ({ ok: true }) })({ chunkPaths: f.paths, targetPath: f.target });
    assert.equal(result.method, 'copy-verified'); assert.equal(f.calls.length, 1);
  });
  test('failure leaves existing output and all sources intact and removes owned work directory', async t => {
    const f = fixture(t);
    const run = async (a, o) => { if (a.includes('libx264')) throw Error('fixture encode failure'); return f.run(a, o); };
    await assert.rejects(createSafeJoin({ probe: f.probe, run, validateCopy: () => ({ ok: false }) })({ chunkPaths: f.paths, targetPath: f.target }), /fixture encode failure/);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'keep-until-success');
    assert.deepEqual(fs.readdirSync(f.root).filter(p => p.startsWith('.vf-safe-join-')), []);
  });
  test('abort during copy never starts the expensive fallback', async t => {
    const f = fixture(t), controller = new AbortController();
    const run = async () => { controller.abort(); controller.signal.throwIfAborted(); };
    await assert.rejects(createSafeJoin({ probe: f.probe, run, validateCopy: () => ({ ok: false }) })({ chunkPaths: f.paths, targetPath: f.target, signal: controller.signal }), /abort/i);
    assert.equal(f.calls.length, 0); assert.equal(fs.readFileSync(f.target, 'utf8'), 'keep-until-success');
  });
  test('wrong normalized/final frame count cannot publish an output', async t => {
    const f = fixture(t);
    const probe = async args => {
      const result = await f.probe(args), info = JSON.parse(result.stdout);
      if (args.at(-1).endsWith('assembled.mp4')) info.streams[0].nb_frames = '1';
      return { ...result, stdout: JSON.stringify(info) };
    };
    await assert.rejects(createSafeJoin({ probe, run: f.run, validateCopy: () => ({ ok: false }) })({ chunkPaths: f.paths, targetPath: f.target }), /frame/i);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'keep-until-success');
  });
}
