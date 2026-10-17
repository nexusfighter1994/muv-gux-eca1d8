import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { customPage } from '../node/custom-page.mjs';
import { GROUPS, MODS } from '../node/mod-registry.mjs';

// Local-only fixture. No production credentials, requests, or persistence.
let revision = null;
const desired = Object.fromEntries(MODS.map(mod => [mod.id, true]));
const defaults = { maxActiveVideos: 15, surplusAttempts: 5, surplusIgnoreBreaker: true, surplusFirst: true,
  autoRetryFailed: 3, surplusRetryMinSec: 10, surplusRetryMaxSec: 20, surplusInsertEfforts: ['low', 'medium', 'high'] };
const settings = { ...defaults };
const config = { enabled: true, cpuWorkers: 5, gpuWorkers: 4, siglipEnabled: true, siglipConcurrency: 1,
  sceneWorkers: 5, clipvaultBoost: 40, ffmpegBoost: 0 };
const limits = { ffmpegMaxFileMb: 64, ffmpegMaxTotalMb: 96, sceneMaxFileMb: 400, siglipMaxImageMb: 20 };
const hooks = Object.fromEntries(MODS.flatMap(mod => mod.hooks).map(key => [key, 'ok']));
const snapshot = () => ({ revision, groups: GROUPS, changedAt: null,
  mods: MODS.map(mod => ({ ...mod, enabled: desired[mod.id], effective: true, pendingRestart: !desired[mod.id] })) });
const nativeCss = ':root{--vc-bg:#0b0b0c;--vc-text:#ececea;--vc-text-dim:#b8b8bb;--vc-text-faint:#a4a4aa;--vc-border:#303033;--vc-accent:#e08a2e;--vc-ok:#65ba87}.vc-input{font:inherit;color:var(--vc-text);background:var(--vc-bg);border:1px solid var(--vc-border);padding:8px 10px}.vc-btn{font:inherit;border:1px solid var(--vc-border);background:transparent;color:var(--vc-text);padding:7px 12px;cursor:pointer}.vc-btn--primary{background:var(--vc-accent);color:#111}.vc-btn:disabled{opacity:.55}.vc-muted{color:var(--vc-text-dim)}';
const assets = new Set(['vf-custom-page.js', 'vf-custom.css', 'pc-boost-settings-20261002.js',
  'pc-boost-settings-20261002.css', 'pc-transfer-settings-20261011.js', 'pc-transfer-settings-20261011.css']);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (body, status = 200, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  let body = {};
  if (req.method === 'PATCH') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { body = JSON.parse(raw); } catch { return send({ error: 'Invalid fixture request' }, 400); }
  }
  if (url.pathname === '/custom' || url.pathname === '/') return send(customPage('<link rel="stylesheet" href="/assets/native.css">'), 200, 'text/html');
  if (url.pathname === '/assets/native.css') return send(nativeCss, 200, 'text/css');
  const asset = url.pathname.replace('/assets/', '');
  if (url.pathname.startsWith('/assets/') && assets.has(asset)) return send(fs.readFileSync(new URL(`../ui/${asset}`, import.meta.url), 'utf8'), 200, asset.endsWith('.css') ? 'text/css' : 'text/javascript');
  if (url.pathname === '/api/me') return send({ csrfToken: 'local-preview-only' });
  if (url.pathname === '/api/vf-custom/mods') {
    if (req.method === 'PATCH') {
      if (body.revision !== revision) return send({ error: 'Fixture changed elsewhere' }, 409);
      for (const [id, value] of Object.entries(body.changes || {})) {
        const definition = MODS.find(mod => mod.id === id);
        if (!definition || definition.readOnly || typeof value !== 'boolean') return send({ error: 'Invalid fixture flag' }, 400);
      }
      Object.assign(desired, body.changes); revision = randomUUID();
    }
    return send(snapshot());
  }
  if (url.pathname === '/api/vf-custom/settings') {
    if (req.method === 'PATCH') Object.assign(settings, body);
    return send({ settings, defaults });
  }
  if (url.pathname === '/api/vf-custom/status') return send({ build: { report: hooks }, runtime: { pcBoostApi: 'ok', customPage: 'ok' }, boost: { ffmpeg: 14, clipvault: 40, pcActive: 2 } });
  if (url.pathname === '/api/pc-boost/bandwidth') return send({ desired: { downMbit: 120, upMbit: 37 }, defaults: { downMbit: 120, upMbit: 37 }, observed: { downMbit: 120, upMbit: 37 }, status: 'active', proof: 'tc_qdisc', bounds: { min: 1, max: 1000 } });
  if (url.pathname === '/api/pc-boost/transfer-limits') return send({ limits, status: 'active', defaults: limits,
    workers: { ffmpeg: { observed: limits }, siglip: { observed: limits } }, senderActivation: { ffmpeg: true, scenes: true, siglip: true } });
  if (url.pathname === '/api/pc-boost') return send({ config, boost: { ffmpeg: 14, clipvault: 40 }, health: {
    checkedAt: new Date().toISOString(), ffmpeg: { reachable: true, ready: true, gpuAvailable: true, nvencReady: true,
      sceneReady: true, cpuActive: 2, gpuActive: 1, sceneActive: 0 },
    siglip: { reachable: true, ready: true, gpuAvailable: true, active: 0 },
  } });
  return send({ error: 'Local preview route not found' }, 404);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`Local UI fixture: http://127.0.0.1:${server.address().port}/custom\n`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
