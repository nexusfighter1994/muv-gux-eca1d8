import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';

export const KIND = 'frameshift-alpha-v1';
export const MAX_BODY = 48 * 1024 * 1024;
export const MAX_ARTIFACT = 32 * 1024 * 1024;
export const MAX_OUTPUT = 128 * 1024 * 1024;
export const MAX_RESPONSE = 176 * 1024 * 1024;
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const payloadSha256 = p => hash(Buffer.from(JSON.stringify(p)));
const execFile = promisify(cp.execFile);
const keys = (o, allowed) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).every(k => allowed.includes(k));

export function decodeBase64(data, maximum = MAX_ARTIFACT) {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(maximum / 3) || data.length % 4 !== 0) {
    throw Error('base64 size/encoding');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== data) throw Error('base64 size/encoding');
  return bytes;
}

export function validate(p, contract) {
  if (!keys(p, ['version', 'id', 'contract', 'kind', 'format', 'compositionHtml', 'renderOnlyHtml',
    'assets', 'fps', 'resolution', 'workers', 'sourceWorkers', 'quality', 'duration', 'timeoutMs'])) throw Error('payload fields');
  if (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 1 || p.timeoutMs > 600000) throw Error('deadline');
  if (typeof contract !== 'string' || !contract || p.contract !== contract || p.version !== 1
    || p.kind !== KIND || p.format !== 'mov' || !/^[a-f0-9]{32}$/.test(p.id)
    || p.fps !== 24 || p.resolution !== '1920x1080'
    || !Number.isInteger(p.sourceWorkers) || p.sourceWorkers < 1 || p.sourceWorkers > 3
    // Home captures with the server's own worker count (frames are identical; the PC has the cores).
    || !Number.isInteger(p.workers) || p.workers < 1 || p.workers > p.sourceWorkers
    || !['draft', 'standard', 'high'].includes(p.quality)
    || !Number.isFinite(p.duration) || p.duration <= 0 || p.duration > 15) throw Error('alpha contract');
  if (typeof p.compositionHtml !== 'string' || !p.compositionHtml
    || Buffer.byteLength(p.compositionHtml) > 2 * 1024 * 1024
    || typeof p.renderOnlyHtml !== 'string' || Buffer.byteLength(p.renderOnlyHtml) > 2 * 1024 * 1024
    || !Array.isArray(p.assets) || p.assets.length > 32) throw Error('payload');
  const names = new Set();
  let total = 0;
  for (const a of p.assets) {
    if (!keys(a, ['filename', 'sha256', 'data']) || typeof a.filename !== 'string'
      || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}$/.test(a.filename)
      || a.filename.includes('..') || a.filename.endsWith('.')
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(a.filename)
      || names.has(a.filename.toLowerCase()) || !/^[a-f0-9]{64}$/.test(a.sha256)) throw Error('asset');
    names.add(a.filename.toLowerCase());
    const bytes = decodeBase64(a.data);
    total += bytes.length;
    if (total > MAX_ARTIFACT || hash(bytes) !== a.sha256) throw Error('asset hash/size');
  }
  if (Buffer.byteLength(JSON.stringify(p)) > MAX_BODY) throw Error('body size');
  return p;
}

export function checkProbe(result, p) {
  const v = result?.streams?.[0];
  const frames = Math.ceil(p.duration * 24);
  if (!v || result.streams.length !== 1 || v.codec_type !== 'video'
    || result.format?.tags?.major_brand?.trim() !== 'qt'
    || v.codec_name !== 'prores' || v.profile !== '4444' || v.codec_tag_string !== 'ap4h'
    || !['yuva444p10le', 'yuva444p12le'].includes(v.pix_fmt)
    || v.width !== 1920 || v.height !== 1080 || v.avg_frame_rate !== '24/1' || v.r_frame_rate !== '24/1'
    || v.time_base !== '1/12288' || Number(v.nb_read_frames) !== frames
    || !Number.isFinite(Number(v.duration)) || Math.abs(Number(v.duration) - frames / 24) > 0.002) {
    throw Error('alpha output contract');
  }
  return v;
}

// Same extrema as a full byte loop, but native indexOf finds 0/255 (the usual alpha
// extremes) without a JS pass over every pixel on the server's main thread.
export function alphaExtrema(chunk, min = 255, max = 0) {
  if (min > 0) {
    if (chunk.indexOf(0) !== -1) min = 0;
    else for (const value of chunk) if (value < min) min = value;
  }
  if (max < 255) {
    if (chunk.indexOf(255) !== -1) max = 255;
    else for (const value of chunk) if (value > max) max = value;
  }
  return {min, max};
}

// Decode every frame, retaining only alpha extrema and byte count (bounded memory).
function scanAlpha(file, frames, ffmpeg, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = cp.spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror',
      '-err_detect', 'explode', '-threads', '1', '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', 'alphaextract', '-pix_fmt', 'gray', '-threads', '1', '-f', 'rawvideo', 'pipe:1'],
    {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    const expected = frames * 1920 * 1080;
    let min = 255, max = 0, pixels = 0, diagnostic = '', failure;
    const stop = error => { failure ??= error; child.kill(); };
    const abort = () => stop(signal.reason ?? Error('alpha decode cancelled'));
    const timer = setTimeout(() => stop(Error('alpha decode deadline')), 30000);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    child.on('error', error => { failure ??= error; });
    child.stdout.on('data', chunk => {
      pixels += chunk.length;
      if (pixels > expected) return stop(Error('alpha decoded frame count'));
      ({min, max} = alphaExtrema(chunk, min, max));
    });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0 || diagnostic.trim() || pixels !== expected || min === 255 || max === 0) {
        return reject(Error('actual alpha/full decode/frame count verification failed'));
      }
      resolve({min, max, pixels, frames});
    });
  });
}

export async function verify(file, p, ffprobe = 'ffprobe', ffmpeg = 'ffmpeg', signal) {
  signal?.throwIfAborted();
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OUTPUT) throw Error('artifact size');
  const output = await execFile(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file],
    {timeout: 30000, windowsHide: true, signal, maxBuffer: 1024 * 1024});
  if (output.stderr.trim()) throw Error('alpha probe/decode error');
  const v = checkProbe(JSON.parse(output.stdout), p);
  const frames = Math.ceil(p.duration * 24);
  const alpha = await scanAlpha(file, frames, ffmpeg, signal);
  return {codec: v.codec_name, profile: v.profile, pixFmt: v.pix_fmt, width: v.width, height: v.height,
    fps: 24, timeBase: v.time_base, frames, duration: Number(v.duration), alpha};
}

// Home renders on the CPU, the browser's software path that the server's own native renders
// use: on the GTX 980 Ti the hardware path measured 2.5-4x slower (same frames, SSIM 0.99).
export const RENDER_BACKEND = 'software/cpu';
export const RENDER_ENV = Object.freeze({PRODUCER_BROWSER_GPU_MODE: 'software', PRODUCER_DISABLE_GPU: 'true'});

// Every render summary must record the software browser mode.
export async function softwareBackend(dir) {
  const modes = [];
  const scan = async current => {
    for (const e of await fs.readdir(current, {withFileTypes: true})) {
      const file = path.join(current, e.name);
      if (e.isDirectory()) await scan(file);
      else if (e.name === 'perf-summary.json') {
        if ((await fs.stat(file)).size > 1024 * 1024) throw Error('render proof size');
        modes.push(JSON.parse(await fs.readFile(file, 'utf8'))?.observability?.capture?.browserGpuMode);
      }
    }
  };
  try { await scan(dir); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw Error('render proof missing');
  }
  if (!modes.length || modes.some(mode => mode !== 'software')) throw Error('render proof missing');
  return RENDER_BACKEND;
}

export async function renderPinned(options, config) {
  const required = ['renderModule', 'cli', 'browser', 'ffmpeg', 'ffprobe'];
  if (!config.files || required.some(k => typeof config[k] !== 'string'
    || !/^[a-f0-9]{64}$/.test(config.files[config[k]] ?? ''))) throw Error('runtime pins required');
  for (const [file, expected] of Object.entries(config.files)) {
    if (!/^[a-f0-9]{64}$/.test(expected) || hash(await fs.readFile(file)) !== expected) throw Error('runtime changed');
  }
  const environment = {...RENDER_ENV,
    PRODUCER_HEADLESS_SHELL_PATH: config.browser, HYPERFRAMES_TELEMETRY_DISABLED: '1',
    HYPERFRAMES_SKIP_SKILLS: '1', CI: '1', TEMP: options.workDir, TMP: options.workDir,
    HOME: options.workDir, USERPROFILE: options.workDir,
    APPDATA: path.join(options.workDir, 'APPDATA'), LOCALAPPDATA: path.join(options.workDir, 'LOCALAPPDATA'),
    PRODUCER_RENDERS_DIR: path.join(options.workDir, 'renders'),
    HYPERFRAMES_FFMPEG_PATH: config.ffmpeg, HYPERFRAMES_FFPROBE_PATH: config.ffprobe};
  await fs.mkdir(environment.APPDATA);
  await fs.mkdir(environment.LOCALAPPDATA);
  const previous = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
  const original = cp.spawn;
  try {
    Object.assign(process.env, environment);
    // Same one-shot child bootstrap as the existing worker; never imported by the app.
    cp.spawn = function(command, args, opts) {
      return /(?:^|[/\\])hyperframes(?:\.cmd)?$/.test(command)
        ? original(process.execPath, [config.cli, ...args, ...(args[0] === 'render' ? ['--debug'] : [])], opts)
        : original(command, args, opts);
    };
    syncBuiltinESMExports();
    const native = await import(pathToFileURL(config.renderModule));
    return await native.render(options);
  } finally {
    cp.spawn = original;
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

export async function execute(p, config, {renderNative = renderPinned} = {}) {
  validate(p, config.contract);
  const root = await fs.mkdtemp(path.join(config.jobRoot ?? process.env.VF_MOTION_JOB_ROOT ?? os.tmpdir(), 'vf-alpha-'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('alpha worker deadline')), p.timeoutMs);
  try {
    const assets = [];
    for (const a of p.assets) {
      const localPath = path.join(root, a.filename);
      await fs.writeFile(localPath, decodeBase64(a.data), {flag: 'wx'});
      assets.push({filename: a.filename, localPath});
    }
    const output = path.join(root, 'result.mov');
    await renderNative({compositionHtml: p.compositionHtml, renderOnlyHtml: p.renderOnlyHtml,
      assets, fps: p.fps, resolution: p.resolution, format: p.format, workers: p.workers, quality: p.quality,
      targetPath: output, workDir: root, timeoutMs: p.timeoutMs, signal: controller.signal}, config);
    controller.signal.throwIfAborted();
    const probe = await verify(output, p, config.ffprobe, config.ffmpeg, controller.signal);
    const backend = await softwareBackend(path.join(root, '.debug'));
    const bytes = await fs.readFile(output);
    if (bytes.length > MAX_OUTPUT) throw Error('artifact size');
    const result = {version: 1, id: p.id, contract: p.contract, kind: KIND, format: 'mov', backend,
      payloadSha256: payloadSha256(p), sha256: hash(bytes), data: bytes.toString('base64'), probe};
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE) throw Error('response size');
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    await fs.rm(root, {recursive: true, force: true});
  }
}

if (typeof import.meta.url === 'string' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
  try {
    const chunks = [];
    let size = 0;
    for await (const b of process.stdin) {
      size += b.length;
      if (size > MAX_BODY) throw Error('body size');
      chunks.push(b);
    }
    const p = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
    process.stdout.write(JSON.stringify(await execute(p, config)));
  } catch (error) {
    process.stderr.write(String(error.message).slice(0, 2000));
    process.exitCode = 1;
  }
  })();
}
