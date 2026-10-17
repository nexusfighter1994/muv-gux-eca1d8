'use strict';
const fs = require('node:fs');
const path = require('node:path');

const entries = 'stream=index,codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,time_base,start_time,duration,nb_frames,sample_rate,channels,channel_layout:format=duration,size,start_time';
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const video = info => info.streams?.find(s => s.codec_type === 'video');
const audio = info => info.streams?.find(s => s.codec_type === 'audio');
const rate = value => { const [n, d = 1] = String(value).split('/').map(Number); return n / d; };
const span = info => Math.max(number(info.format?.duration), number(video(info)?.duration), number(audio(info)?.duration));
const quote = file => "file '" + file.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
function checkAbort(signal) { signal?.throwIfAborted(); }

function createSafeJoin({ probe, run, validateCopy }) {
  async function inspect(file, signal) {
    checkAbort(signal);
    const result = await probe(['-v', 'error', '-show_entries', entries, '-of', 'json', file], { signal, timeoutMs: 60000 });
    if (result?.code && result.code !== 0) throw Error('Safe join: media probe failed');
    const info = JSON.parse(typeof result === 'string' ? result : result.stdout);
    if (!video(info) || !(number(video(info).duration) > 0)) throw Error('Safe join: missing video or duration');
    return info;
  }
  async function verifiedCopy({ chunkPaths, targetPath, signal, emit = () => {} }) {
    if (!chunkPaths?.length) throw Error('Safe join: no chunks');
    checkAbort(signal);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const work = fs.mkdtempSync(path.join(path.dirname(targetPath), '.vf-safe-join-'));
    const execute = arguments[0].run || run;
    const inputInfo = [];
    try {
      for (const file of chunkPaths) inputInfo.push(await inspect(file, signal));
      const duration = inputInfo.reduce((sum, info) => sum + span(info), 0);
      const candidate = path.join(work, 'copy.mp4'), manifest = path.join(work, 'copy.txt');
      fs.writeFileSync(manifest, chunkPaths.map(quote).join('\n'));
      // The validator checks stream contracts and exact frame preservation, not only duration.
      try {
        await execute(['-f', 'concat', '-safe', '0', '-i', manifest, '-c', 'copy', '-movflags', '+faststart', candidate],
          { signal, timeoutMs: Math.max(600000, Math.ceil(duration * 200)) });
        const outputInfo = await inspect(candidate, signal), proof = validateCopy(inputInfo, outputInfo);
        if (proof.ok) {
          checkAbort(signal); fs.renameSync(candidate, targetPath);
          return { method: 'copy-verified', durationSec: number(video(outputInfo).duration), frameCount: number(video(outputInfo).nb_frames) };
        }
        emit({ level: 'warn', step: 'finalAssembly', message: 'Safe join: copy integrity requires bounded normalization.', data: { reason: proof.reason } });
      } catch (error) {
        checkAbort(signal);
        if (error?.name === 'AbortError') throw error;
        emit({ level: 'warn', step: 'finalAssembly', message: 'Safe join: packet-copy failed; using bounded normalization.' });
      }
      const reference = video(inputInfo[0]), fps = reference.r_frame_rate || reference.avg_frame_rate;
      const frequency = rate(fps), width = number(reference.width), height = number(reference.height);
      if (!(frequency > 0 && width > 0 && height > 0)) throw Error('Safe join: invalid reference contract');
      const gop = String(Math.max(1, Math.round(frequency * 2))), normalized = [], normalizedInfo = [];
      for (let i = 0; i < chunkPaths.length; i++) {
        checkAbort(signal);
        const file = path.join(work, 'normalized-' + i + '.mov'), inputDuration = number(video(inputInfo[i]).duration);
        const videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v]`;
        const audioFilter = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${inputDuration.toFixed(6)},asetpts=PTS-STARTPTS[a]`;
        const filters = `[0:v:0]${videoFilter};` + (audio(inputInfo[i]) ? `[0:a:0]${audioFilter}` : `anullsrc=r=48000:cl=stereo,atrim=0:${inputDuration.toFixed(6)},asetpts=PTS-STARTPTS[a]`);
        emit({ step: 'finalAssembly', message: `Safe join: normalizing chunk ${i + 1}/${chunkPaths.length} (one decoder).` });
        // PCM avoids one AAC priming delay per chunk. AAC is encoded exactly once in the final join.
        await execute(['-i', chunkPaths[i], '-filter_complex', filters, '-map', '[v]', '-map', '[a]',
          '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', fps,
          '-g', gop, '-keyint_min', gop, '-sc_threshold', '0', '-flags', '+cgop', '-color_range', 'tv',
          '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
          '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', file],
        { signal, timeoutMs: Math.max(1800000, Math.ceil(inputDuration * 2500)) });
        const info = await inspect(file, signal), v = video(info), a = audio(info);
        if (v.codec_name !== 'h264' || v.profile !== 'High' || v.pix_fmt !== 'yuv420p' || v.width !== width || v.height !== height ||
            !(number(v.nb_frames) > 0) || Math.abs(number(v.duration) - inputDuration) > 1 / frequency + 0.001 ||
            a?.codec_name !== 'pcm_s24le' || Math.abs(number(a.duration) - inputDuration) > 0.001) {
          throw Error('Safe join: normalized chunk failed stream/frame/duration validation');
        }
        normalized.push(file); normalizedInfo.push(info);
      }
      const finalList = path.join(work, 'normalized.txt'), assembled = path.join(work, 'assembled.mp4');
      fs.writeFileSync(finalList, normalized.map(quote).join('\n'));
      await execute(['-f', 'concat', '-safe', '0', '-i', finalList, '-map', '0:v:0', '-map', '0:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', assembled],
      { signal, timeoutMs: Math.max(1800000, Math.ceil(duration * 2500)) });
      const finalInfo = await inspect(assembled, signal), finalVideo = video(finalInfo), finalAudio = audio(finalInfo);
      const expectedFrames = normalizedInfo.reduce((sum, info) => sum + number(video(info).nb_frames), 0);
      const expectedDuration = normalizedInfo.reduce((sum, info) => sum + span(info), 0);
      if (number(finalVideo.nb_frames) !== expectedFrames || finalVideo.codec_name !== 'h264' || finalVideo.profile !== 'High' ||
          finalVideo.width !== width || finalVideo.height !== height || finalVideo.pix_fmt !== 'yuv420p' ||
          finalAudio?.codec_name !== 'aac' || Math.abs(span(finalInfo) - expectedDuration) > Math.max(0.1, 2 / frequency) ||
          Math.abs(number(finalAudio.duration) - expectedDuration) > Math.max(0.1, 2 / frequency)) {
        throw Error('Safe join: bounded output failed frame/stream/duration validation');
      }
      checkAbort(signal); fs.renameSync(assembled, targetPath);
      return { method: 'bounded-reencode', durationSec: number(finalVideo.duration), frameCount: expectedFrames, maxDecoders: 1 };
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  }
  return verifiedCopy;
}

module.exports = { createSafeJoin, entries };
