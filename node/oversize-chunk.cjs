'use strict';
// vf-custom:oversize-chunk-v1 (2026-11-22). Owner: "was scheitert da? FIXE ES!"
//
// 43a0317f (JA, 185 chunks) failed twice at its last chunk with "fflow POST /v1/render: HTTP 422": the text-to-audio
// alignment had left 889.9 s of narration in chunk 185, the planner filled it with 216 b-roll segments (all rendered),
// and FFlow's CompositionRequest rejects more than 100 segment entries (216 clips + 124 transitions = 340). The app
// requeues the video by itself, so it looped. One ffmpeg with 216 inputs would also be a RAM risk (the single pass is
// capped at 40 inputs for that reason).
//
// A chunk with more than `splitAbove` segments is now composed in parts of at most `partSegments` clips: each part
// gets its slice of the chunk voiceover (cut sample-exact to WAV), its own FFlow payload from the app's own builder
// and its own normal composition call; the parts are then joined by stream copy (MPEG-TS with in-band parameter
// sets, track timescale 12288 like every chunk). The transition at a part boundary becomes a hard cut. Finished
// parts are kept until the chunk is done, so a retry continues where it stopped.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const DEFAULTS = { enabled: true, splitAbove: 40, partSegments: 30, fps: 24 };
const KNOB = '/data/runtime/vf-oversize-chunk.json';

function readKnob(file = KNOB, read = p => fs.readFileSync(p, 'utf8')) {
  try {
    const raw = JSON.parse(read(file));
    const out = { ...DEFAULTS };
    if (raw && raw.enabled === false) out.enabled = false;
    for (const key of ['splitAbove', 'partSegments']) {
      const v = Number(raw && raw[key]);
      if (Number.isInteger(v) && v >= 5 && v <= 90) out[key] = v;
    }
    return out;
  } catch { return { ...DEFAULTS }; }
}

function transitionList(transitions) {
  if (Array.isArray(transitions)) return transitions;
  if (transitions && Array.isArray(transitions.transitions)) return transitions.transitions;
  return [];
}

const afterOf = t => Number(t?.after_segment ?? t?.after ?? t?.segment ?? t?.boundary_after);

// Even groups of at most `partSegments` clips with frame-aligned time windows. The last window ends at the
// chunk's voiceover duration, so the parts add up to exactly the chunk.
function planParts({ segments, transitions, totalSec, partSegments = DEFAULTS.partSegments, fps = DEFAULTS.fps }) {
  const n = segments.length;
  const total = Number(totalSec);
  if (!(n > 0) || !(total > 0) || !(partSegments >= 1)) throw new Error('oversize-chunk: invalid plan input');
  const count = Math.ceil(n / partSegments);
  const base = Math.floor(n / count);
  let extra = n - base * count;
  const list = transitionList(transitions);
  const parts = [];
  let index = 0;
  let cumSec = 0;
  let startFrame = 0;
  for (let k = 0; k < count; k += 1) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    const from = index;
    const to = index + size;
    for (let i = from; i < to; i += 1) {
      const d = Number(segments[i]?.duration_sec ?? segments[i]?.durationSec);
      if (!(d > 0)) throw new Error(`oversize-chunk: segment ${i + 1} has no duration`);
      cumSec += d;
    }
    const last = k === count - 1;
    const endFrame = last ? Math.round(total * fps) : Math.round(cumSec * fps);
    const startSec = startFrame / fps;
    const durationSec = last ? Math.max(0, total - startSec) : (endFrame - startFrame) / fps;
    if (!(durationSec > 0)) throw new Error(`oversize-chunk: part ${k + 1} has no duration`);
    const inner = list
      .filter(t => { const a = afterOf(t); return Number.isInteger(a) && a >= from + 1 && a <= to - 1; })
      .map(t => {
        const copy = { ...t };
        for (const key of ['after', 'segment', 'boundary_after']) delete copy[key];
        copy.after_segment = afterOf(t) - from;
        return copy;
      });
    parts.push({ index: k, from, to, startSec, durationSec, transitions: inner });
    index = to;
    startFrame = endFrame;
  }
  return parts;
}

function partKey(part, segments, voiceover) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ v: 1, from: part.from, to: part.to, start: part.startSec, duration: part.durationSec,
    voiceover, transitions: part.transitions,
    segments: segments.slice(part.from, part.to).map(s => [s.outputSource ?? s.source ?? null, s.duration_sec ?? null, s.effects ?? null, s.fill ?? null, s.audio ?? null]) }));
  return h.digest('hex').slice(0, 24);
}

function run(execFile, file, args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const tail = String(stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
        reject(new Error(`${path.basename(file)} failed: ${error.code ?? error.signal ?? error.message}${tail ? ' — ' + tail : ''}`));
      } else resolve(String(stdout || ''));
    });
  });
}

async function probeDuration(execFile, file) {
  const out = await run(execFile, 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 60000);
  const value = Number(String(out).trim().split('\n')[0]);
  if (!(value > 0)) throw new Error(`oversize-chunk: no duration for ${path.basename(file)}`);
  return value;
}

const AUDIO_RATES = [96, 128, 160, 192, 256, 320];

// Video by stream copy with the concat demuxer on the MP4 parts: its automatic h264_mp4toannexb conversion keeps the
// parameter sets in-band (parts may come from different encoders: server x264, Home NVENC) and each part is placed
// at its exact frame count. (Going through MPEG-TS left the video track 2 frames short in the dry run of 22.11.,
// the B-frame delay of the first part.) Audio is decoded per part, cut to
// exactly that part's length and encoded once: joining the parts' AAC streams directly grew the audio by one AAC
// frame per part (dry run 22.11.: 3 chunks -> +0.07 s), and the app compares chunk durations to the frame.
async function joinParts({ files, dir, tempPath, fps, execFile }) {
  const videoList = [];
  const audioList = [];
  const quote = f => `file '${f.replace(/'/g, "'\\''")}'`;
  let frames = 0;
  let bitrate = 192;
  for (let i = 0; i < files.length; i += 1) {
    const video = files[i];
    const count = Number(String(await run(execFile, 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', video], 120000)).trim().split('\n')[0]);
    if (!(count > 0)) throw new Error(`oversize-chunk: no video frames in ${path.basename(video)}`);
    const seconds = count / fps;
    if (i === 0) {
      const kbit = Number(String(await run(execFile, 'ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate',
        '-of', 'csv=p=0', video], 60000)).trim().split('\n')[0]) / 1000;
      if (kbit > 0) bitrate = AUDIO_RATES.reduce((best, r) => (Math.abs(r - kbit) < Math.abs(best - kbit) ? r : best), 192);
    }
    const wav = `${video}.wav`;
    await run(execFile, 'ffmpeg', ['-v', 'error', '-y', '-i', video, '-map', '0:a:0', '-vn', '-af', `apad=whole_dur=${seconds.toFixed(6)}`,
      '-t', seconds.toFixed(6), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', wav]);
    videoList.push(`${quote(video)}\nduration ${seconds.toFixed(6)}`);
    audioList.push(quote(wav));
    frames += count;
  }
  const videoTxt = path.join(dir, 'video.txt');
  const audioTxt = path.join(dir, 'audio.txt');
  fs.writeFileSync(videoTxt, videoList.join('\n') + '\n');
  fs.writeFileSync(audioTxt, audioList.join('\n') + '\n');
  // Two steps: joined in one command the video track started 21 ms late (the parts' audio priming offset leaked
  // into the video timestamps); a video-only join first starts at 0 like every native chunk.
  const videoOnly = path.join(dir, 'video.mp4');
  await run(execFile, 'ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', videoTxt, '-map', '0:v:0', '-an', '-c:v', 'copy',
    '-video_track_timescale', '12288', '-f', 'mp4', videoOnly], 1800000);
  await run(execFile, 'ffmpeg', ['-v', 'error', '-y', '-i', videoOnly, '-f', 'concat', '-safe', '0', '-i', audioTxt,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${bitrate}k`, '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '12288', '-movflags', '+faststart', '-f', 'mp4', tempPath], 1800000);
  fs.rmSync(videoOnly, { force: true });
  const seconds = await probeDuration(execFile, tempPath);
  return { frames, seconds, expectedSeconds: frames / fps, bitrate };
}

function createOversizeChunk({ buildPayload, renderPart, basePath, tmpPath, finish, isMock = () => false,
  settings = () => readKnob(), execFile = childProcess.execFile, log = () => {}, now = () => Date.now() }) {
  const stats = { chunks: 0, parts: 0, reused: 0, failed: 0, last: null, lastError: null };

  function shouldSplit(args) {
    const cfg = settings();
    if (!cfg.enabled || !args || !Array.isArray(args.segmentResults)) return false;
    if (typeof args.deps?.renderChunk === 'function') return false;
    try { if (isMock()) return false; } catch { return false; }
    return args.segmentResults.length > cfg.splitAbove;
  }

  // Same mapping as the app's own chunk render (segment row -> payload segment).
  function mapSegments(segmentResults, polish) {
    return [...segmentResults].sort((a, b) => Number(a.segment_id) - Number(b.segment_id)).map(g => {
      let audio = null;
      if (g.audio_json) {
        try { const v = JSON.parse(g.audio_json); if (v && typeof v === 'object') audio = v; } catch { audio = null; }
      }
      const type = g.finalType || g.type;
      if (g.type === 'b_roll_video_audio') {
        if (type === 'b_roll_video_audio' && audio?.include === true) audio = { ...audio, muteVoiceover: true };
        else audio = null;
      }
      const extra = polish?.get?.(String(g.id ?? g.segment_id)) || null;
      return { type: 'video', outputSource: g.outputPath, duration_sec: g.duration_sec,
        ...(audio ? { audio } : {}),
        ...(extra?.effects?.length ? { effects: extra.effects } : {}),
        ...(extra?.fill ? { fill: extra.fill } : {}) };
    });
  }

  async function render(args) {
    const { jobId, slug, chunkNumber, row, segmentResults, transitions, motionBlur, polish = null, outputQuality = null } = args;
    const cfg = settings();
    const started = now();
    const segments = mapSegments(segmentResults, polish);
    const total = Number(row.duration_s);
    const parts = planParts({ segments, transitions, totalSec: total, partSegments: cfg.partSegments, fps: cfg.fps });
    const finalPath = basePath(slug, chunkNumber);
    const tempPath = tmpPath(finalPath);
    const dir = `${finalPath}.parts`;
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(tempPath, { force: true });
    stats.chunks += 1;
    log(`chunk ${chunkNumber}: ${segments.length} segments, ${total.toFixed(1)} s -> ${parts.length} parts of <= ${cfg.partSegments}`);
    const files = [];
    try {
      for (const part of parts) {
        const key = partKey(part, segments, row.voiceover_path);
        const video = path.join(dir, `part_${part.index + 1}_${key}.mp4`);
        const marker = `${video}.ok`;
        files.push(video);
        if (fs.existsSync(video) && fs.existsSync(marker)) { stats.reused += 1; continue; }
        const voice = path.join(dir, `voice_${part.index + 1}_${key}.wav`);
        // Output seeking: decoded from the start, cut sample-exact. "-f mp3" guards the known VVC misdetection.
        const input = /\.mp3$/i.test(String(row.voiceover_path)) ? ['-f', 'mp3', '-i', row.voiceover_path] : ['-i', row.voiceover_path];
        await run(execFile, 'ffmpeg', ['-v', 'error', '-y', ...input, '-ss', part.startSec.toFixed(6), '-t', part.durationSec.toFixed(6),
          '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', voice]);
        const payload = buildPayload({ segments: segments.slice(part.from, part.to), transitions: part.transitions,
          voiceoverSource: voice, voiceoverDurationSec: part.durationSec, filename: `chunk_${chunkNumber}_part${part.index + 1}.mp4`,
          ...(typeof motionBlur === 'boolean' ? { motionBlur } : {}), ...(outputQuality ? { outputQuality } : {}) });
        fs.rmSync(video, { force: true });
        await renderPart({ payload, targetPath: video, jobId, chunkId: row.id, contentSeconds: part.durationSec });
        const got = await probeDuration(execFile, video);
        if (Math.abs(got - part.durationSec) > 0.5) throw new Error(`oversize-chunk: part ${part.index + 1} is ${got.toFixed(2)} s, expected ${part.durationSec.toFixed(2)} s`);
        fs.writeFileSync(marker, JSON.stringify({ durationSec: part.durationSec, measuredSec: got, at: new Date(now()).toISOString() }));
        fs.rmSync(voice, { force: true });
        stats.parts += 1;
        log(`chunk ${chunkNumber}: part ${part.index + 1}/${parts.length} done (${got.toFixed(1)} s)`);
      }
      const joined = await joinParts({ files, dir, tempPath, fps: cfg.fps, execFile });
      if (Math.abs(joined.seconds - total) > 0.25) throw new Error(`oversize-chunk: joined chunk is ${joined.seconds.toFixed(2)} s, expected ${total.toFixed(2)} s`);
      const result = await finish(tempPath, finalPath);
      fs.rmSync(dir, { recursive: true, force: true });
      stats.last = { chunkNumber, jobId: String(jobId).slice(0, 8), parts: parts.length, segments: segments.length, seconds: Math.round((now() - started) / 1000), joinedSec: joined.seconds, frames: joined.frames, at: new Date(now()).toISOString() };
      log(`chunk ${chunkNumber}: joined ${parts.length} parts (${joined.seconds.toFixed(2)} s, ${joined.frames} frames) in ${stats.last.seconds} s`);
      return result;
    } catch (error) {
      stats.failed += 1;
      stats.lastError = { chunkNumber, message: String(error?.message || error).slice(0, 300), at: new Date(now()).toISOString() };
      for (const f of files) { fs.rmSync(`${f}.ts`, { force: true }); fs.rmSync(`${f}.wav`, { force: true }); }
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  return { shouldSplit, render, mapSegments, stats };
}

module.exports = { createOversizeChunk, joinParts, planParts, partKey, readKnob, transitionList, DEFAULTS, KNOB };
