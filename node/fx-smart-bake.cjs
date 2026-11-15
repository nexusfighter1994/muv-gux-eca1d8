'use strict';
// Chunk FX transitions (native ZUn/chunk_fx) replace a few short windows, yet the native step re-encodes the whole
// chunk: 32 % of the server's FFmpeg CPU on 2026-11-09. Base chunks are closed-GOP (48 frames), so only the GOPs that
// touch a window need encoding; every other GOP is copied bit-exact (no generation loss).
// The re-encoded GOPs use the native bake's own filter graph and encode arguments, and any doubt falls back to the
// native full encode. Off switch without restart: /data/runtime/fx-smart-bake.json {"enabled":false}.
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const VERSION = 'fx-smart-bake-v1';
const SWITCH_FILE = process.env.VF_FX_SMART_BAKE_CONFIG || '/data/runtime/fx-smart-bake.json';
const MAX_ENCODED_SHARE = 0.6;
const stats = globalThis.__vfFxSmartBake ||= {
  version: VERSION, smart: 0, full: 0, fallbacks: 0, framesEncoded: 0, framesCopied: 0,
  lastReason: null, lastError: null, lastAt: null,
};

let cached = { at: -Infinity, enabled: true };
function enabled(now = Date.now(), read = () => fs.readFileSync(SWITCH_FILE, 'utf8')) {
  if (now - cached.at > 2000) {
    let value = true;
    try { value = JSON.parse(read())?.enabled !== false; } catch { /* no file: on */ }
    cached = { at: now, enabled: value };
  }
  return cached.enabled;
}

function ffprobe(args, { signal, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', args, { signal, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  });
}

function parsePackets(text) {
  const packets = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [pts, dts, flags] = line.trim().split(',');
    const value = Number(pts);
    if (!Number.isFinite(value)) throw new Error('packet without pts');
    packets.push({ pts: value, dts: Number(dts), key: String(flags || '').startsWith('K') });
  }
  return packets;
}

// Display index of each packet, and the display indexes where a closed GOP starts.
function closedGopStarts(packets) {
  const byPts = packets.map((p, decode) => ({ pts: p.pts, decode })).sort((a, b) => a.pts - b.pts);
  const rank = new Array(packets.length);
  byPts.forEach((p, display) => { rank[p.decode] = display; });
  for (let i = 1; i < byPts.length; i++) if (byPts[i].pts === byPts[i - 1].pts) throw new Error('duplicate pts');
  const suffixMin = new Array(packets.length + 1).fill(Infinity);
  for (let i = packets.length - 1; i >= 0; i--) suffixMin[i] = Math.min(suffixMin[i + 1], rank[i]);
  let prefixMax = -1;
  const starts = [];
  for (let i = 0; i < packets.length; i++) {
    // A GOP is closed when nothing decoded earlier shows after it and nothing decoded later shows before it.
    if (packets[i].key && prefixMax < rank[i] && suffixMin[i] === rank[i]) starts.push(rank[i]);
    prefixMax = Math.max(prefixMax, rank[i]);
  }
  return { rank, starts: starts.sort((a, b) => a - b) };
}

// [{from,to}] frame ranges that must be re-encoded: every GOP touched by a window, merged.
function encodeRanges(pieces, starts, totalFrames) {
  if (!starts.length || starts[0] !== 0) throw new Error('first frame is not a closed GOP start');
  const ranges = [];
  for (const piece of [...pieces].sort((a, b) => a.start - b.start)) {
    if (!Number.isInteger(piece.start) || !Number.isInteger(piece.end)
        || piece.start < 0 || piece.end <= piece.start || piece.end > totalFrames) throw new Error('invalid window');
    let from = 0;
    for (const s of starts) { if (s <= piece.start) from = s; else break; }
    let to = totalFrames;
    for (const s of starts) { if (s >= piece.end) { to = s; break; } }
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }
  return ranges;
}

// Alternating copy/encode plan that covers every frame exactly once.
function planParts(ranges, totalFrames) {
  const parts = [];
  let at = 0;
  for (const range of ranges) {
    if (range.from > at) parts.push({ kind: 'copy', from: at, to: range.from });
    parts.push({ kind: 'encode', from: range.from, to: range.to });
    at = range.to;
  }
  if (at < totalFrames) parts.push({ kind: 'copy', from: at, to: totalFrames });
  return parts;
}

function piecesIn(pieces, range) {
  return pieces.filter(p => p.start >= range.from && p.end <= range.to)
    .map(p => ({ start: p.start - range.from, end: p.end - range.from, offset: p.offset }));
}

function argValue(args, key) {
  const index = args.indexOf(key);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function frameRate(encodeArgs) {
  const [num, den = '1'] = String(argValue(encodeArgs, '-r') || '').split('/');
  const n = Number(num), d = Number(den);
  if (!(Number.isInteger(n) && Number.isInteger(d) && n > 0 && d > 0)) throw new Error('no constant frame rate');
  return { num: n, den: d };
}

// Exact decimal seconds of a frame boundary; refuses rates that cannot be written exactly in microseconds.
function seconds(frame, rate) {
  const micro = frame * rate.den * 1e6 / rate.num;
  if (!Number.isInteger(micro)) throw new Error('frame boundary is not an exact timestamp');
  return (micro / 1e6).toFixed(6);
}

// The native bake's arguments for one range: same graph and encoder, video only, input seeked to the GOP start.
function encodeArgsFor(buildFullArgs, args, range, rate, outPath) {
  const full = buildFullArgs({
    ...args, pieces: piecesIn(args.pieces, range), totalFrames: range.to - range.from, outPath,
  });
  const out = [];
  for (let i = 0; i < full.length; i++) {
    if (full[i] === '-map' && full[i + 1] === '0:a?') { i++; continue; }
    if (full[i] === '-c:a') { i++; continue; }
    out.push(full[i]);
  }
  const target = out.pop();
  return ['-ss', seconds(range.from, rate), ...out, '-an', target];
}

function quote(file) { return `'${String(file).replace(/'/g, "'\\''")}'`; }

function concatList(parts, basePath, rate, totalFrames) {
  const lines = ['ffconcat version 1.0'];
  for (const part of parts) {
    if (part.kind === 'encode') { lines.push(`file ${quote(part.path)}`); continue; }
    lines.push(`file ${quote(basePath)}`, `inpoint ${seconds(part.from, rate)}`);
    if (part.to < totalFrames) lines.push(`outpoint ${seconds(part.to, rate)}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseFrameHashes(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map(s => s.trim());
    if (cols.length >= 6) rows.push({ pts: Number(cols[2]), size: Number(cols[4]), hash: cols[5] });
  }
  return rows.sort((a, b) => a.pts - b.pts);
}

// Copied non-key packets must be byte-identical and in the same display position (key packets gain in-band headers).
function verifyCopied(parts, basePackets, baseRows, outRows, rank) {
  if (baseRows.length !== outRows.length) throw new Error(`packet count ${outRows.length}, expected ${baseRows.length}`);
  const keyDisplay = new Set();
  basePackets.forEach((p, decode) => { if (p.key) keyDisplay.add(rank[decode]); });
  let compared = 0;
  for (const part of parts) {
    if (part.kind !== 'copy') continue;
    for (let frame = part.from; frame < part.to; frame++) {
      if (keyDisplay.has(frame)) continue;
      if (baseRows[frame].hash !== outRows[frame].hash) throw new Error(`copied frame ${frame} differs`);
      compared++;
    }
  }
  return compared;
}

async function runSmart(buildFullArgs, args, ffmpeg, options, plan) {
  const { basePath, outPath, encodeArgs } = plan.input;
  for (const part of plan.parts) {
    if (part.kind !== 'encode') continue;
    await ffmpeg(encodeArgsFor(buildFullArgs, args, part, plan.rate, part.path), options);
    options.signal?.throwIfAborted?.();
  }
  fs.writeFileSync(plan.listPath, concatList(plan.parts, basePath, plan.rate, plan.totalFrames));
  const timescale = argValue(encodeArgs, '-video_track_timescale');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', plan.listPath, '-i', basePath, '-map', '0:v:0', '-map', '1:a?',
    '-c', 'copy', ...(timescale ? ['-video_track_timescale', timescale] : []),
    '-movflags', '+negative_cts_offsets', outPath], options);
  options.signal?.throwIfAborted?.();
  const hashes = async file => parseFrameHashes((await ffmpeg(
    ['-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framemd5', '-'], options)).stdout);
  const [baseRows, outRows] = [await hashes(basePath), await hashes(outPath)];
  verifyCopied(plan.parts, plan.packets, baseRows, outRows, plan.rank);
  // Every splice must decode cleanly; a broken reference aborts here and the native full encode runs.
  await ffmpeg(['-xerror', '-i', outPath, '-map', '0:v:0', '-f', 'null', '-'], options);
}

async function makePlan(args, options) {
  const { basePath, totalFrames, encodeArgs, pieces, outPath } = args;
  if (encodeArgs.includes('-output_ts_offset')) return { skip: 'chunk has a start offset' };
  const rate = frameRate(encodeArgs);
  const packets = parsePackets(await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'packet=pts,dts,flags', '-of', 'csv=p=0', basePath], options));
  if (packets.length !== totalFrames) return { skip: `base has ${packets.length} frames, planned ${totalFrames}` };
  const { rank, starts } = closedGopStarts(packets);
  const ranges = encodeRanges(pieces, starts, totalFrames);
  const encoded = ranges.reduce((sum, r) => sum + r.to - r.from, 0);
  if (encoded / totalFrames > MAX_ENCODED_SHARE) return { skip: `would encode ${encoded}/${totalFrames} frames` };
  const parts = planParts(ranges, totalFrames);
  parts.forEach((part, index) => { if (part.kind === 'encode') part.path = `${outPath}.smart-${index}.mp4`; });
  return { input: args, rate, packets, rank, parts, encoded, totalFrames, listPath: `${outPath}.smart.ffconcat` };
}

async function bakeChunk({ buildFullArgs, args, ffmpeg, options = {} }) {
  const full = () => ffmpeg(buildFullArgs(args), options);
  stats.lastAt = new Date().toISOString();
  if (!enabled()) { stats.full++; stats.lastReason = 'switched off'; return full(); }
  let plan = null;
  try {
    plan = await makePlan(args, options);
    if (plan.skip) { stats.full++; stats.lastReason = plan.skip; return full(); }
    await runSmart(buildFullArgs, args, ffmpeg, options, plan);
    stats.smart++;
    stats.framesEncoded += plan.encoded;
    stats.framesCopied += plan.totalFrames - plan.encoded;
    return { method: 'smart', encoded: plan.encoded, totalFrames: plan.totalFrames };
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw error;
    stats.fallbacks++;
    stats.lastError = String(error?.message || error).slice(0, 300);
    console.warn(`[vf-fx-smart-bake] falling back to the native full encode: ${stats.lastError}`);
    fs.rmSync(args.outPath, { force: true });
    return full();
  } finally {
    for (const part of plan?.parts || []) if (part.path) fs.rmSync(part.path, { force: true });
    if (plan?.listPath) fs.rmSync(plan.listPath, { force: true });
  }
}

module.exports = {
  VERSION, stats, enabled, parsePackets, closedGopStarts, encodeRanges, planParts, piecesIn, frameRate, seconds,
  encodeArgsFor, concatList, parseFrameHashes, verifyCopied, makePlan, bakeChunk,
};
