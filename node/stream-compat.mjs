const compatFs = process.getBuiltinModule('fs');
const compatCrypto = process.getBuiltinModule('crypto');
const compatiblePending = new Map();

export function createCompatibleConcat(original, { probe, run, key = 'localPaths', convertUnsafe = true }) {
  async function inspect(path, signal) {
    const result = await probe(['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate,time_base,duration,sample_rate,channels:format=duration',
      '-of', 'json', path], { signal, timeoutMs: 60000 });
    return JSON.parse(typeof result === 'string' ? result : result.stdout);
  }
  async function compatible(path, options) {
    const signal = options.signal;
    signal?.throwIfAborted();
    const info = await inspect(path, signal);
    const video = info.streams?.find(s => s.codec_type === 'video');
    // Lossless High 4:4:4 uses transform bypass. Mixing it with High in one AVC
    // track silently corrupts continuous playback, despite clean per-file decodes.
    if (video?.codec_name !== 'h264' || video.profile !== 'High 4:4:4 Predictive') return path;
    if (!convertUnsafe) throw new Error(`Unsafe AVC chunk detected; automatic conversion is disabled: ${path}`);
    if (video.pix_fmt !== 'yuv420p') throw new Error(`Unsupported lossless chunk pixel format: ${video.pix_fmt}`);
    const stat = compatFs.statSync(path);
    const identity = compatCrypto.createHash('sha256').update(JSON.stringify([
      'high-contract-v1', path, stat.size, stat.mtimeMs,
    ])).digest('hex').slice(0, 16);
    const target = `${path}.high-${identity}.mp4`;
    const duration = Number(video.duration || info.format?.duration);
    const audio = info.streams.filter(s => s.codec_type === 'audio');
    async function validate(file) {
      const after = await inspect(file, signal), v = after.streams?.find(s => s.codec_type === 'video');
      if (v?.profile !== 'High' || v.codec_name !== 'h264' || v.pix_fmt !== video.pix_fmt ||
          v.width !== video.width || v.height !== video.height || v.avg_frame_rate !== video.avg_frame_rate ||
          v.time_base !== video.time_base || Math.abs(Number(v.duration) - duration) > .1 ||
          JSON.stringify(after.streams.filter(s => s.codec_type === 'audio')) !== JSON.stringify(audio)) {
        throw new Error(`Chunk AVC compatibility check failed: ${path}`);
      }
    }
    if (compatFs.existsSync(target)) { await validate(target); return target; }
    if (compatiblePending.has(target)) { await compatiblePending.get(target); signal?.throwIfAborted(); return target; }
    const task = (async () => {
      const temp = `${target}.${compatCrypto.randomUUID()}.mp4`;
      try {
        const timescale = /^1\/(\d+)$/.exec(video.time_base)?.[1];
        await run(['-y', '-i', path, '-map', '0:v:0', '-map', '0:a?',
          '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '18',
          '-pix_fmt', 'yuv420p', '-profile:v', 'high',
          ...(timescale ? ['-video_track_timescale', timescale] : []),
          '-c:a', 'copy', '-movflags', '+faststart', temp],
        { signal, timeoutMs: Math.max(900000, duration * 3000) });
        await validate(temp);
        signal?.throwIfAborted();
        compatFs.renameSync(temp, target);
        console.info(`[vf-custom] AVC compatibility conformed ${path} (High 4:4:4 Predictive -> High)`);
      } finally { compatFs.rmSync(temp, { force: true }); }
    })();
    compatiblePending.set(target, task);
    try { await task; } finally { if (compatiblePending.get(target) === task) compatiblePending.delete(target); }
    return target;
  }
  return async function compatibleConcat(options, ...rest) {
    options.signal?.throwIfAborted();
    const paths = [];
    for (const path of options[key] || []) paths.push(await compatible(path, options));
    options.signal?.throwIfAborted();
    return original.call(this, { ...options, [key]: paths }, ...rest);
  };
}
