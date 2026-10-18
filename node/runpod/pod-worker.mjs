// Runs ON the RunPod pod (stock VidForge image): renders frameshift jobs with the image's own
// native renderer, so results equal a server render. Async job API because the RunPod HTTP
// proxy closes requests after 100 s: POST /jobs, GET /jobs/:id, GET /jobs/:id/result, DELETE.
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const TOKEN = process.env.VF_POD_TOKEN || '';
const PORT = Number(process.env.VF_POD_PORT || 8080);
const RENDER_MODULE = process.env.VF_POD_RENDER_MODULE || '/app/render/frameshift/lib/render.js';
const ROOT = process.env.VF_POD_ROOT || path.join(os.tmpdir(), 'vf-pod-jobs');
const SLOTS = Math.max(1, Math.min(8, Number(process.env.VF_POD_SLOTS) || Math.floor(os.cpus().length / 3) || 1));
const SIGLIP = process.env.VF_POD_SIGLIP_URL || 'http://127.0.0.1:8081';
export const MAX_BODY = 64 * 1024 * 1024, MAX_ASSETS = 32 * 1024 * 1024, KEEP_MS = 15 * 60000, SIGLIP_BODY = 176 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function versionOf(name) {
  try { return createRequire(RENDER_MODULE)(name + '/package.json').version; } catch { return null; }
}
function gpuName() {
  try { return execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 }).toString().trim().split('\n')[0] || null; } catch { return null; }
}

export function validateJob(p) {
  const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('payload');
  if (!/^[a-f0-9]{32}$/.test(p.id || '')) fail('id');
  if (!['alpha', 'opaque'].includes(p.kind) || (p.kind === 'alpha') !== (p.format === 'mov') || !['mov', 'mp4'].includes(p.format)) fail('kind/format');
  if (p.fps !== 24 || p.resolution !== '1920x1080') fail('fps/resolution');
  if (!Number.isInteger(p.workers) || p.workers < 1 || p.workers > 3) fail('workers');
  if (!['draft', 'standard', 'high'].includes(p.quality)) fail('quality');
  if (!Number.isFinite(p.duration) || p.duration <= 0 || p.duration > 15) fail('duration');
  if (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 1 || p.timeoutMs > 600000) fail('deadline');
  if (typeof p.compositionHtml !== 'string' || !p.compositionHtml || Buffer.byteLength(p.compositionHtml) > 2 * 1024 * 1024
    || typeof p.renderOnlyHtml !== 'string' || Buffer.byteLength(p.renderOnlyHtml) > 2 * 1024 * 1024) fail('html');
  if (!Array.isArray(p.assets) || p.assets.length > 32) fail('assets');
  const names = new Set(); let total = 0; const assets = [];
  for (const a of p.assets) {
    if (!a || typeof a.filename !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}$/.test(a.filename) || a.filename.includes('..')
      || names.has(a.filename.toLowerCase()) || !/^[a-f0-9]{64}$/.test(a.sha256 || '') || typeof a.data !== 'string') fail('asset');
    names.add(a.filename.toLowerCase());
    const bytes = Buffer.from(a.data, 'base64');
    total += bytes.length;
    if (total > MAX_ASSETS || sha(bytes) !== a.sha256) fail('asset hash/size');
    assets.push({ filename: a.filename, bytes });
  }
  return { ...p, assets };
}

export function createPodWorker({ render, slots = SLOTS, root = ROOT, token = TOKEN, now = Date.now, info = {}, siglipUrl = SIGLIP, fetchImpl = fetch } = {}) {
  if (typeof render !== 'function') throw new TypeError('render required');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('VF_POD_TOKEN must be 64 hex characters');
  const jobs = new Map(), queue = [];
  let active = 0;
  const pump = () => {
    while (active < slots && queue.length) {
      const job = queue.shift();
      if (job.state !== 'queued') continue;
      active++; job.state = 'running'; job.startedAt = now();
      void run(job).finally(() => { active--; pump(); });
    }
  };
  async function run(job) {
    const dir = await fs.mkdtemp(path.join(root, 'job-'));
    job.dir = dir;
    try {
      const assets = [];
      for (const a of job.p.assets) { const localPath = path.join(dir, a.filename); await fs.writeFile(localPath, a.bytes); assets.push({ filename: a.filename, localPath }); }
      job.p.assets = null;
      const targetPath = path.join(dir, 'result.' + job.p.format);
      const deadline = setTimeout(() => job.controller.abort(Error('pod render deadline')), job.p.timeoutMs);
      try {
        await render({ compositionHtml: job.p.compositionHtml, renderOnlyHtml: job.p.renderOnlyHtml, assets, fps: job.p.fps, resolution: job.p.resolution,
          format: job.p.format, workers: job.p.workers, quality: job.p.quality, targetPath, workDir: path.join(dir, 'work'), timeoutMs: job.p.timeoutMs,
          signal: job.controller.signal });
      } finally { clearTimeout(deadline); }
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      const bytes = await fs.readFile(targetPath);
      if (!bytes.length) throw Error('empty output');
      Object.assign(job, { state: 'done', result: targetPath, size: bytes.length, sha256: sha(bytes), doneAt: now() });
    } catch (error) {
      Object.assign(job, { state: job.state === 'cancelled' ? 'cancelled' : 'failed', error: String(error?.message || error).slice(0, 2000), doneAt: now() });
    }
  }
  const sweep = async () => {
    for (const [id, job] of jobs) {
      if (job.doneAt && now() - job.doneAt > KEEP_MS) { jobs.delete(id); if (job.dir) await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {}); }
    }
  };
  const authorized = req => {
    const given = Buffer.from(String(req.headers.authorization || ''));
    const wanted = Buffer.from('Bearer ' + token);
    return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
  };
  const send = (res, status, body) => { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text); };
  async function readBody(req, limit = MAX_BODY) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(Error('body size'), { status: 413 }); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function handle(req, res) {
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://pod'), match = url.pathname.match(/^\/jobs\/([a-f0-9]{32})(\/result)?$/);
    if (req.method === 'GET' && url.pathname === '/health') {
      let siglip = null;
      try {
        const r = await fetchImpl(siglipUrl + '/health', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2000) });
        if (r.ok) { const h = await r.json(); siglip = { ready: h.ready === true, device: h.device ?? null, active: h.active_tasks ?? null, concurrency: h.configured_concurrency ?? null }; }
      } catch { /* SigLIP still installing or off */ }
      return send(res, 200, { ok: true, slots, active, queued: queue.filter(j => j.state === 'queued').length, siglip, ...info });
    }
    // SigLIP rank service on the pod GPU (same service as the Home PC), same token.
    if (url.pathname.startsWith('/siglip/')) {
      const body = req.method === 'POST' || req.method === 'PUT' ? Buffer.from(JSON.stringify(await readBody(req, SIGLIP_BODY))) : undefined;
      const upstream = await fetchImpl(siglipUrl + url.pathname.slice('/siglip'.length) + url.search, { method: req.method,
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(95000) });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'content-length': bytes.length });
      return res.end(bytes);
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const p = validateJob(await readBody(req));
      if (jobs.has(p.id)) return send(res, 409, { error: 'duplicate' });
      if (queue.filter(j => j.state === 'queued').length >= slots) return send(res, 503, { error: 'busy' });
      const job = { id: p.id, p, state: 'queued', controller: new AbortController(), createdAt: now() };
      jobs.set(p.id, job); queue.push(job); pump();
      return send(res, 202, { id: p.id, state: job.state });
    }
    if (!match) return send(res, 404, { error: 'not_found' });
    const job = jobs.get(match[1]);
    if (!job) return send(res, 404, { error: 'unknown job' });
    if (req.method === 'GET' && !match[2]) return send(res, 200, { id: job.id, state: job.state, error: job.error ?? null, size: job.size ?? null, sha256: job.sha256 ?? null });
    if (req.method === 'GET' && match[2]) {
      if (job.state !== 'done') return send(res, 409, { error: 'not done' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': job.size, 'x-sha256': job.sha256 });
      return createReadStream(job.result).pipe(res);
    }
    if (req.method === 'DELETE' && !match[2]) {
      if (job.state === 'queued' || job.state === 'running') { job.state = 'cancelled'; job.controller.abort(Error('cancelled')); }
      if (job.dir) await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(job.id);
      return send(res, 200, { terminated: true });
    }
    return send(res, 405, { error: 'method' });
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => { if (!res.headersSent) send(res, error.status || 500, { error: String(error?.message || error).slice(0, 300) }); else res.destroy(); });
  });
  const sweeper = setInterval(() => void sweep(), 60000); sweeper.unref?.();
  return { server, jobs, close: () => { clearInterval(sweeper); server.close(); } };
}

// Chrome on the pod GPU when RunPod exposes graphics (EGL): much faster for heavy filters (blur,
// mix-blend). Not pixel-identical to the server's software path, which the user accepts; any
// probe failure keeps the server's software path. VF_POD_GPU_MODE=software forces it.
async function probeGpuMode() {
  if (process.env.VF_POD_GPU_MODE === 'software') return 'software';
  try {
    const base = '/root/.cache/hyperframes/chrome/chrome-headless-shell';
    const [build] = (await fs.readdir(base)).sort().reverse();
    const executablePath = path.join(base, build, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    const puppeteer = createRequire(RENDER_MODULE)('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath, headless: 'shell', timeout: 30000,
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-software-rasterizer', '--enable-webgl'] });
    try {
      const page = await browser.newPage();
      const renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; });
      return /nvidia/i.test(renderer || '') ? 'hardware' : 'software';
    } finally { await browser.close().catch(() => {}); }
  } catch { return 'software'; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fs.mkdir(ROOT, { recursive: true });
  const native = await import(pathToFileURL(RENDER_MODULE).href);
  const gpuMode = await probeGpuMode();
  if (gpuMode === 'hardware') process.env.PRODUCER_BROWSER_GPU_MODE = 'hardware';
  const info = { hyperframes: versionOf('hyperframes'), node: process.version, cpus: os.cpus().length, gpu: gpuName(), gpuMode };
  const worker = createPodWorker({ render: options => native.render(options), info });
  worker.server.requestTimeout = 0;
  worker.server.listen(PORT, '0.0.0.0', () => console.log(`[vf-pod] listening on ${PORT}, slots ${SLOTS}, hyperframes ${info.hyperframes}, gpu ${info.gpu}, chrome ${gpuMode}`));
}
