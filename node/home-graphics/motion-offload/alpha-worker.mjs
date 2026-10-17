import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports, createRequire} from 'node:module';
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
      for (const value of chunk) { if (value < min) min = value; if (value > max) max = value; }
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

export async function renderPinned(options, config) {
  const required = ['renderModule', 'cli', 'browser', 'ffmpeg', 'ffprobe'];
  if (!config.files || required.some(k => typeof config[k] !== 'string'
    || !/^[a-f0-9]{64}$/.test(config.files[config[k]] ?? ''))) throw Error('runtime pins required');
  for (const [file, expected] of Object.entries(config.files)) {
    if (!/^[a-f0-9]{64}$/.test(expected) || hash(await fs.readFile(file)) !== expected) throw Error('runtime changed');
  }
  const environment = {PRODUCER_BROWSER_GPU_MODE: 'hardware', PRODUCER_DISABLE_GPU: 'false',
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

// Same classification as the renderer's own classifyGpuRenderer (backend/vendor).
export function classifyRenderer(renderer) {
  if (typeof renderer !== 'string' || !renderer) return null;
  const r = renderer.toLowerCase();
  const backend = r.includes('swiftshader') ? 'swiftshader' : r.includes('direct3d11') || r.includes('d3d11') ? 'd3d11' : 'other';
  return backend + '/' + (r.includes('nvidia') ? 'nvidia' : 'other');
}

// The renderer's hardware launch flags on Windows (getBrowserGpuArgs "hardware"/win32).
export const HARDWARE_GPU_ARGS = ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist',
  '--use-gl=angle', '--use-angle=d3d11', '--enable-gpu-rasterization'];

// WebGL renderer of the PINNED browser launched with the renderer's hardware flags.
export async function probeHardwareGpu(config, workDir) {
  const puppeteer = createRequire(config.renderModule)('puppeteer-core');
  const profile = await fs.mkdtemp(path.join(workDir, 'gpu-probe-'));
  const browser = await puppeteer.launch({executablePath: config.browser, headless: 'shell', userDataDir: profile,
    args: HARDWARE_GPU_ARGS, timeout: 30000});
  try {
    const page = await browser.newPage();
    return classifyRenderer(await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    }));
  } finally {
    await browser.close().catch(() => {});
  }
}

// The renderer runs its WebGL probe only on the drawElement path. Parallel capture
// (workers > 1, clampReason "parallel") and compositions the drawElement compile gate
// rejects (e.g. compileGate "mix_blend_mode") capture by screenshot without it, so those
// perf summaries carry no gpuRenderer. Screenshot frames match the server's capture; the
// backend is then proven by probing the same pinned browser.
const unprobedScreenshot = d => d && d.gpuRenderer === undefined && d.mode === 'screenshot'
  && (d.clampReason === 'parallel' || (typeof d.compileGate === 'string' && d.compileGate !== ''));

export async function proveBackend(perfs, probe) {
  if (!perfs.length) throw Error('hardware proof missing');
  let unprobed = false;
  for (const d of perfs) {
    if (d?.gpuRenderer === 'd3d11/nvidia') continue;
    if (unprobedScreenshot(d)) { unprobed = true; continue; }
    throw Error('hardware proof missing');
  }
  if (unprobed && await probe().catch(() => null) !== 'd3d11/nvidia') throw Error('hardware proof missing');
  return 'd3d11/nvidia';
}

async function hardwareBackend(root, probe) {
  const perfs = [];
  const scan = async dir => {
    for (const e of await fs.readdir(dir, {withFileTypes: true})) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await scan(file);
      else if (e.name === 'perf-summary.json') {
        if ((await fs.stat(file)).size > 1024 * 1024) throw Error('hardware proof size');
        perfs.push(JSON.parse(await fs.readFile(file, 'utf8')).drawElement);
      }
    }
  };
  try { await scan(path.join(root, '.debug')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw Error('hardware proof missing');
  }
  return proveBackend(perfs, probe);
}

export async function execute(p, config, {renderNative = renderPinned, probeGpu = probeHardwareGpu} = {}) {
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
    const backend = await hardwareBackend(root, () => probeGpu(config, root));
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
