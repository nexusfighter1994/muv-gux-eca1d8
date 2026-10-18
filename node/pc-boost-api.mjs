import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  cpuWorkers: 5,
  gpuWorkers: 4,
  siglipEnabled: true,
  siglipConcurrency: 1,
  sceneWorkers: 5,
  // v17: server concurrency while the PC is verified connected (0 = no boost; only ever raises).
  clipvaultBoost: 40,
  ffmpegBoost: 0,
  // Home motion graphics: parallel Home renders the server offers, and the share (%) of a
  // render's deadline Home may use before the server renders it itself (fresh full deadline).
  motionSlots: 2,
  motionHomeShare: 70,
  // SigLIP embeddings the server's own engine runs at once while the PC SigLIP is ready
  // (node/siglip-native-cap.cjs); the rest waits for the PC. OCR is not affected.
  siglipServerEmbeds: 1,
  // Job order: jobs before segment rendering first (script, voiceover, audio, chunk planning),
  // finish-first from segment rendering on (node/scheduling-settings.cjs).
  earlyPhasePriority: true,
  // RunPod burst: while this many frameshift renders wait, start the cheapest GPU pod within
  // the price cap (cents per hour); stop it again at the lower mark. Off by default.
  burstEnabled: false,
  burstStartQueue: 200,
  burstStopQueue: 10,
  burstMaxCents: 30,
  burstMaxHours: 12,
  // Allowed RunPod GPU type ids ([] = any within the price cap); the strongest available is taken.
  burstGpuTypes: Object.freeze([]),
});
// Settings the PC worker knows; the boost targets above stay on the server.
export const PC_CONFIG_KEYS = Object.freeze(['enabled', 'cpuWorkers', 'gpuWorkers', 'siglipEnabled', 'siglipConcurrency', 'sceneWorkers']);
export const CONFIG_BOUNDS = Object.freeze({
  cpuWorkers: Object.freeze({ min: 0, max: 25 }),
  gpuWorkers: Object.freeze({ min: 0, max: 25 }),
  siglipConcurrency: Object.freeze({ min: 1, max: 25 }),
  sceneWorkers: Object.freeze({ min: 0, max: 25 }),
  clipvaultBoost: Object.freeze({ min: 0, max: 200 }),
  ffmpegBoost: Object.freeze({ min: 0, max: 64 }),
  motionSlots: Object.freeze({ min: 1, max: 8 }),
  // Above 100 Home may take longer than the server's own render deadline (Home caps at 10 min).
  motionHomeShare: Object.freeze({ min: 50, max: 200 }),
  siglipServerEmbeds: Object.freeze({ min: 0, max: 25 }),
  burstStartQueue: Object.freeze({ min: 5, max: 5000 }),
  burstStopQueue: Object.freeze({ min: 0, max: 1000 }),
  burstMaxCents: Object.freeze({ min: 5, max: 300 }),
  burstMaxHours: Object.freeze({ min: 1, max: 24 }),
});
// The RunPod API key is write-only: never part of the config, the runtime file or a reply.
export const BURST_SECRET_PATH = '/data/runtime/runpod-api-key';
const RUNTIME_PATH = '/data/runtime/pc-boost.json';
const TOKEN_PATH = '/data/runtime/pc-boost-token';
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_config' });
}

export const BANDWIDTH_BOUNDS = Object.freeze({ min: 1, max: 1000 });
export const BANDWIDTH_DEFAULTS = Object.freeze({ downMbit: 120, upMbit: 37 });
const BANDWIDTH_KEYS = ['downMbit', 'upMbit'];
export function validateBandwidth(patch, current = null) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || !Object.keys(patch).length || Object.keys(patch).some(key => !BANDWIDTH_KEYS.includes(key))) {
    throw invalid('Bandwidth must contain only downMbit and upMbit.');
  }
  const next = { ...current, ...patch };
  for (const key of BANDWIDTH_KEYS) {
    if (!Number.isSafeInteger(next[key]) || next[key] < 1 || next[key] > 1000) {
      throw invalid(`${key} must be a whole number from 1 to 1000 Mbit/s. Uncapped is not supported by this worker.`);
    }
  }
  return Object.fromEntries(BANDWIDTH_KEYS.map(key => [key, next[key]]));
}

export function createBandwidthStore({ db }) {
  const select = db.prepare('SELECT value_json FROM app_settings WHERE key = ?');
  const write = db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json');
  let current = { desired: null, revision: null };
  const row = select.get('pc_boost_bandwidth');
  if (row) {
    const saved = JSON.parse(row.value_json);
    if (!saved || typeof saved.revision !== 'string' || !/^[0-9a-f-]{36}$/.test(saved.revision)) {
      throw new Error('Invalid persisted bandwidth revision');
    }
    current = { desired: validateBandwidth(saved.desired), revision: saved.revision };
  }
  return {
    get: () => ({ desired: current.desired && { ...current.desired }, revision: current.revision }),
    update(patch) {
      const next = { desired: validateBandwidth(patch, current.desired), revision: randomUUID() };
      write.run('pc_boost_bandwidth', JSON.stringify(next));
      current = next;
      return this.get();
    },
  };
}

// VF is CPU-only. The shared PC worker may still report GPU capacity for other callers.
export function pcFfmpegCapacity(worker) { return count(worker?.cpuCapacity) || 0; }
export function pcFfmpegActive(worker) { return Math.min(pcFfmpegCapacity(worker), count(worker?.cpuActive) || 0); }

export function installBandwidthControls({ app, db, requireOwner,
  readToken = () => fs.readFileSync(TOKEN_PATH, 'utf8').trim(), now = Date.now, logger = console }) {
  const installation = Symbol.for('vf.pcBoost.bandwidth');
  if (app[installation]) {
    positionBandwidthRoutes(app);
    publishBandwidthDefaults(app);
    return app[installation];
  }
  let store;
  try { store = createBandwidthStore({ db }); }
  catch { logger.error('[pc-boost] Bandwidth settings unavailable; existing settings retained.'); }
  let readback;
  const snapshot = () => {
    const state = store.get();
    const fresh = readback && now() - readback.time <= 20000;
    const matched = fresh && readback.revision === state.revision
      && BANDWIDTH_KEYS.every(key => readback.observed[key] === state.desired?.[key]);
    return { ...state, defaults: BANDWIDTH_DEFAULTS, observed: fresh ? { ...readback.observed } : null,
      checkedAt: fresh ? new Date(readback.time).toISOString() : null,
      status: !fresh ? 'bridge_offline' : !state.desired ? 'unmanaged' : matched ? 'active' : 'pending',
      proof: 'tc_qdisc', bounds: BANDWIDTH_BOUNDS, uncappedSupported: false,
      scope: 'home_boost_tunnel' };
  };
  const unavailable = res => res.status(503).json({ error: 'Bandwidth settings unavailable.', code: 'bandwidth_unavailable' });
  const authenticate = (req, res, next) => {
    try {
      const expected = readToken();
      const header = req.headers?.authorization;
      const supplied = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!expected || !supplied || expected.length > 4096 || supplied.length > 4096
        || /[\r\n]/.test(expected)) throw new Error('Unavailable');
      const a = Buffer.from(expected), b = Buffer.from(supplied);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Unauthorized');
      return next();
    } catch { return res.status(401).json({ error: 'Unauthorized.', code: 'unauthorized' }); }
  };
  app.get('/api/pc-boost/bandwidth', requireOwner, (_req, res) => store ? res.json(snapshot()) : unavailable(res));
  app.patch('/api/pc-boost/bandwidth', requireOwner, (req, res) => {
    if (!store) return unavailable(res);
    try {
      store.update(req.body);
      const state = snapshot();
      // A freshly saved revision has no acknowledgement yet, even if the PC is offline.
      return res.json({ ...state, status: 'pending' });
    } catch (error) {
      return res.status(error.status === 400 ? 400 : 503).json({
        error: error.status === 400 ? error.message : 'Bandwidth settings could not be saved.',
        code: error.status === 400 ? 'invalid_config' : 'bandwidth_save_failed' });
    }
  });
  app.get('/api/pc-boost/bandwidth/bridge', authenticate, (_req, res) => store ? res.json(store.get()) : unavailable(res));
  app.post('/api/pc-boost/bandwidth/readback', authenticate, (req, res) => {
    if (!store) return unavailable(res);
    const body = req.body;
    const observed = body?.observed;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 3 || !own(body, 'revision') || !own(body, 'observed')
      || body.proof !== 'tc_qdisc'
      || !(body.revision === null || (typeof body.revision === 'string' && /^[0-9a-f-]{36}$/.test(body.revision)))
      || !observed || typeof observed !== 'object' || Array.isArray(observed)
      || Object.keys(observed).length !== 2 || BANDWIDTH_KEYS.some(key =>
        !own(observed, key) || !Number.isFinite(observed[key]) || observed[key] <= 0 || observed[key] > 1000)) {
      return res.status(400).json({ error: 'Invalid bandwidth readback.', code: 'invalid_config' });
    }
    readback = { observed: { ...observed }, revision: body.revision, time: now() };
    return res.json({ ok: true, proof: 'tc_qdisc' });
  });
  positionBandwidthRoutes(app);
  publishBandwidthDefaults(app);
  return app[installation] = { store, snapshot };
}

export function publishBandwidthDefaults(app) {
  const stack = app._router?.stack || app.router?.stack;
  for (const layer of stack || []) {
    if (layer.route?.path !== '/api/pc-boost/bandwidth') continue;
    const entry = layer.route.stack.at(-1);
    if (!entry?.handle || entry.handle.__vfBandwidthDefaults) continue;
    const original = entry.handle;
    function withDefaults(req, res, next) {
      const send = res.json;
      res.json = function (body) {
        res.json = send;
        return send.call(this, body && typeof body === 'object' && !body.error
          ? { ...body, defaults: BANDWIDTH_DEFAULTS } : body);
      };
      return original(req, res, next);
    }
    withDefaults.__vfBandwidthDefaults = true;
    entry.handle = withDefaults;
  }
}

export function positionBandwidthRoutes(app) {
  const stack = app._router?.stack || app.router?.stack;
  if (Array.isArray(stack)) {
    // Late hot-installs must precede the native API terminal, but remain after
    // native session/CSRF guards. At normal startup no terminal exists yet.
    const terminal = stack.find(layer => !layer.route && typeof layer.handle === 'function'
      && String(layer.handle).includes('404') && String(layer.handle).includes('Not found'));
    if (terminal) {
      const ownerPaths = ['/api/pc-boost/bandwidth'];
      const owners = stack.filter(layer => ownerPaths.includes(layer.route?.path));
      for (const layer of owners) stack.splice(stack.indexOf(layer), 1);
      stack.splice(stack.indexOf(terminal), 0, ...owners);
    }
    const bridgePaths = ['/api/pc-boost/bandwidth/bridge', '/api/pc-boost/bandwidth/readback'];
    const layers = stack.filter(layer => bridgePaths.includes(layer.route?.path));
    const guardIndex = stack.findIndex(layer => {
      if (layer.route || typeof layer.match !== 'function') return false;
      const { params, path: previousPath } = layer;
      try { return layer.match('/api') && !layer.match('/__vf_pc_boost_not_api__'); }
      finally { layer.params = params; layer.path = previousPath; }
    });
    if (guardIndex >= 0) {
      for (const layer of layers) stack.splice(stack.indexOf(layer), 1);
      stack.splice(guardIndex, 0, ...layers);
    }
  }
}

export function validateConfig(patch, current = DEFAULT_CONFIG) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw invalid('PC Boost settings must be a JSON object.');
  }
  for (const key of Object.keys(patch)) {
    if (!own(DEFAULT_CONFIG, key)) throw invalid('Unknown PC Boost setting.');
    const value = patch[key];
    if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      if (typeof value !== 'boolean') throw invalid(`${key} must be true or false.`);
    } else if (Array.isArray(DEFAULT_CONFIG[key])) {
      if (!Array.isArray(value) || value.length > 40 || new Set(value).size !== value.length
        || !value.every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,79}$/.test(v))) throw invalid(`${key} must be a list of GPU type names.`);
    } else {
      const { min, max } = CONFIG_BOUNDS[key];
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw invalid(`${key} must be a whole number from ${min} to ${max}.`);
      }
    }
  }
  const next = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key => [key, own(patch, key) ? patch[key] : current[key]]));
  if (next.burstStopQueue >= next.burstStartQueue) throw invalid('burstStopQueue must be lower than burstStartQueue.');
  return next;
}

export function publishConfig(runtimePath, config) {
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
  const temporary = `${runtimePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(config)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, runtimePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Motion, burst, server-SigLIP and scheduling keys live in their own rows: an older image validating the pc_boost row
// strictly would otherwise treat unknown keys as corrupt and fall back to defaults (PC Boost off).
export const MOTION_CONFIG_KEYS = Object.freeze(['motionSlots', 'motionHomeShare']);
export const BURST_CONFIG_KEYS = Object.freeze(['burstEnabled', 'burstStartQueue', 'burstStopQueue', 'burstMaxCents', 'burstMaxHours', 'burstGpuTypes']);
export const SIGLIP_SERVER_KEYS = Object.freeze(['siglipServerEmbeds']);
export const SCHEDULING_KEYS = Object.freeze(['earlyPhasePriority']);
const SIDE_ROWS = Object.freeze({ pc_motion: MOTION_CONFIG_KEYS, pc_burst: BURST_CONFIG_KEYS, pc_siglip_server: SIGLIP_SERVER_KEYS,
  pc_scheduling: SCHEDULING_KEYS });
const sideKey = key => Object.values(SIDE_ROWS).some(keys => keys.includes(key));
const only = (config, keys) => Object.fromEntries(Object.entries(config).filter(([key]) => keys.includes(key)));
const mainPart = config => Object.fromEntries(Object.entries(config).filter(([key]) => !sideKey(key)));
const API_KEY = /^[A-Za-z0-9_-]{16,256}$/;

function writeSecret(secretPath, value) {
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  if (value === '') { try { fs.unlinkSync(secretPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } return; }
  const temporary = `${secretPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, secretPath);
}

export function createConfigStore({ db, runtimePath = RUNTIME_PATH,
  publish = config => publishConfig(runtimePath, config), secretPath = BURST_SECRET_PATH }) {
  const select = db.prepare('SELECT value_json FROM app_settings WHERE key = ?');
  const write = db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json');
  let current = { ...DEFAULT_CONFIG };
  const row = select.get('pc_boost');
  if (row) {
    try { current = validateConfig(mainPart(JSON.parse(row.value_json))); } catch { /* Corrupt settings fail closed. */ }
  }
  for (const [key, keys] of Object.entries(SIDE_ROWS)) {
    const side = select.get(key);
    if (side) {
      try { current = validateConfig(only(JSON.parse(side.value_json), keys), current); } catch { /* Corrupt side row keeps defaults. */ }
    }
  }
  const store = config => {
    write.run('pc_boost', JSON.stringify(mainPart(config)));
    for (const [key, keys] of Object.entries(SIDE_ROWS)) write.run(key, JSON.stringify(only(config, keys)));
  };
  // The burst controller's status (no token, no key) rides along for the /custom card.
  const burstStatus = () => { try { return globalThis.__vfBurst?.status?.() ?? null; } catch { return null; } };
  const reportable = () => ({ ...current, burstApiKeySet: fs.existsSync(secretPath), burstStatus: burstStatus() });
  db.transaction(() => {
    store(current);
    publish(current);
  })();
  return {
    get: reportable,
    update(input) {
      let patch = input;
      if (patch && typeof patch === 'object' && !Array.isArray(patch) && own(patch, 'burstApiKey')) {
        const { burstApiKey, ...rest } = patch;
        const key = typeof burstApiKey === 'string' ? burstApiKey.trim() : null;
        if (key === null || (key !== '' && !API_KEY.test(key))) throw invalid('burstApiKey must be a RunPod API key (or empty to remove it).');
        validateConfig(rest, current);
        writeSecret(secretPath, key);
        patch = rest;
      }
      const next = validateConfig(patch, current);
      let published = false;
      try {
        db.transaction(() => {
          store(next);
          publish(next);
          published = true;
        })();
      } catch (error) {
        if (published) publish(current);
        throw error;
      }
      current = next;
      return reportable();
    },
  };
}

function workerUrl(value, port) {
  const url = new URL(value || `http://10.0.3.1:${port}`);
  // Only the explicitly supported internal gateways can receive the token.
  if (url.protocol !== 'http:' || !['127.0.0.1', '10.0.3.1'].includes(url.hostname)
    || url.port !== String(port) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid private PC Boost worker address');
  }
  return url.origin;
}

function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function boolean(value) { return typeof value === 'boolean' ? value : null; }
function configFromHealth(data) {
  const candidate = data?.config;
  if (!candidate || !PC_CONFIG_KEYS.every(key => own(candidate, key))) return null;
  try { return validateConfig(Object.fromEntries(PC_CONFIG_KEYS.map(key => [key, candidate[key]]))); } catch { return null; }
}

function sanitizedHealth(kind, result) {
  const data = result.data || {};
  const ready = result.ok && (data.ready === true || data.ok === true || data.status === 'ok');
  const base = {
    reachable: result.reachable,
    ready,
    reason: result.ok ? (ready ? 'ready' : 'not_ready') : result.reason,
    config: configFromHealth(data),
    gpuAvailable: boolean(data.gpuAvailable ?? data.gpuReady ?? data.gpu_available ?? data.cuda_available ?? data.capabilities?.gpu),
  };
  if (kind === 'ffmpeg') return {
    ...base,
    cpuActive: result.ok ? count(data.cpuActive ?? data.cpuBusy ?? data.active?.cpu ?? data.busy?.cpu ?? data.cpu?.active) : null,
    cpuBusy: result.ok ? count(data.cpuBusy) : null,
    gpuActive: result.ok ? count(data.gpuActive ?? data.gpuBusy ?? data.active?.gpu ?? data.busy?.gpu ?? data.gpu?.active) : null,
    gpuBusy: result.ok ? count(data.gpuBusy) : null,
    cpuCapacity: result.ok ? count(data.cpuCapacity) : null,
    gpuCapacity: result.ok ? count(data.gpuCapacity) : null,
    completedCpu: result.ok ? count(data.completedCpu) : null,
    completedGpu: result.ok ? count(data.completedGpu) : null,
    gpuMode: result.ok && ['nvenc-high-qp14-v1', 'cuda-decode-original-x264'].includes(data.gpuMode) ? data.gpuMode : null,
    nvencReady: result.ok && data.nvencReady === true,
    completedNvenc: result.ok ? count(data.completedNvenc) : null,
    graphicsBusy: result.ok ? count(data.graphicsBusy) : null,
    graphicsCapacity: result.ok ? count(data.graphicsCapacity ?? data.graphicsSlots) : null,
    completedMap: result.ok ? count(data.completedMap ?? data.MapCompleted) : null,
    completedMotion: result.ok ? count(data.completedMotion ?? data.MotionCompleted) : null,
    completedAlpha: result.ok ? count(data.completedAlpha) : null,
    // v11: scene detection on the PC (own capacity lane)
    sceneReady: result.ok && data.sceneReady === true,
    sceneCapacity: result.ok ? count(data.sceneCapacity) : null,
    sceneActive: result.ok ? count(data.sceneActive ?? data.sceneBusy) : null,
    // v15: sceneCapacity = accepted (workers + the PC's short queue); workers run at once.
    sceneWorkers: result.ok ? count(data.sceneWorkers) : null,
    sceneQueued: result.ok ? count(data.sceneQueued) : null,
    completedScene: result.ok ? count(data.completedScene) : null,
  };
  return { ...base,
    active: result.ok ? count(data.active ?? data.active_tasks ?? data.activeRequests ?? data.busy) : null,
    acceptedConcurrency: result.ok ? count(data.configured_concurrency) : null,
    gpuConcurrency: result.ok ? count(data.gpu_inference_concurrency) : null,
    completed: result.ok ? count(data.completed_gpu_tasks) : null,
  };
}

async function boundedJSON(response) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('Worker response exceeds limit'); }
      chunks.push(Buffer.from(value));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid worker response');
    return result;
  } finally { reader.releaseLock(); }
}

export function createWorkerClient({
  fetchImpl = globalThis.fetch,
  readToken = () => fs.readFileSync(TOKEN_PATH, 'utf8').trim(),
  timeoutMs = 900,
  ffmpegUrl = process.env.VF_PC_BOOST_FFMPEG_URL,
  siglipUrl = process.env.VF_PC_BOOST_SIGLIP_URL,
} = {}) {
  const urls = { ffmpeg: workerUrl(ffmpegUrl, 18191), siglip: workerUrl(siglipUrl, 18194) };
  async function request(kind, pathname, method = 'GET', config, deadlineMs = timeoutMs) {
    let token;
    try {
      token = readToken();
      if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Missing token');
    } catch { return { ok: false, reachable: false, reason: 'authentication_unavailable' }; }
    const controller = new AbortController();
    let timer;
    let reachable = false;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reachable, reason: 'timeout' });
      }, deadlineMs);
    });
    const operation = (async () => {
      try {
        const response = await fetchImpl(`${urls[kind]}${pathname}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json',
            ...(config ? { 'content-type': 'application/json' } : {}) },
          ...(config ? { body: JSON.stringify(config) } : {}),
          signal: controller.signal,
          redirect: 'error',
        });
        reachable = true;
        if (!response.ok) {
          await response.body?.cancel();
          return { ok: false, reachable, reason: [401, 403].includes(response.status) ? 'unauthorized' : 'http_error' };
        }
        const data = await boundedJSON(response);
        return { ok: true, reachable, data };
      } catch {
        return { ok: false, reachable, reason: controller.signal.aborted ? 'timeout' : reachable ? 'invalid_response' : 'offline' };
      }
    })();
    try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
  }
  return {
    async health({ deadlineMs = timeoutMs } = {}) {
      const [ffmpeg, siglip] = await Promise.all([
        request('ffmpeg', '/health', 'GET', undefined, deadlineMs),
        request('siglip', '/health', 'GET', undefined, deadlineMs),
      ]);
      return { checkedAt: new Date().toISOString(),
        ffmpeg: sanitizedHealth('ffmpeg', ffmpeg), siglip: sanitizedHealth('siglip', siglip) };
    },
    async sync(config) {
      const result = {};
      const pcConfig = Object.fromEntries(PC_CONFIG_KEYS.filter(key => own(config || {}, key)).map(key => [key, config[key]]));
      for (const kind of ['ffmpeg', 'siglip']) {
        const response = await request(kind, '/config', 'PUT', pcConfig);
        result[kind] = { ok: response.ok, reason: response.ok ? 'applied' : response.reason };
      }
      return result;
    },
  };
}

export function installPcBoost({ app, db, requireOwner, runtimePath = RUNTIME_PATH,
  workerClient, reconcileIntervalMs = 15000, logger = console }) {
  installBandwidthControls({ app, db, requireOwner, logger });
  let store;
  let workers;
  try {
    store = createConfigStore({ db, runtimePath });
    workers = workerClient || createWorkerClient();
  } catch {
    logger.error('[pc-boost] Settings initialization failed; PC Boost API unavailable.');
  }
  let healthPromise;
  let healthCached;
  let healthTime = 0;
  let syncing;
  let syncAgain = false;
  const getHealth = async () => {
    // The background capacity probe refreshes this every 5 s with a patient deadline; the UI
    // reuses it instead of firing its own 900 ms probe, which flickered rows to "offline".
    if (healthCached && Date.now() - healthTime < 15000) return healthCached;
    if (!healthPromise) healthPromise = workers.health({ deadlineMs: 5000 }).then(value => {
      healthCached = value;
      healthTime = Date.now();
      return value;
    }).finally(() => { healthPromise = undefined; });
    return healthPromise;
  };
  const reconcile = () => {
    if (!store || !workers) return Promise.resolve();
    if (syncing) { syncAgain = true; return syncing; }
    syncing = (async () => {
      do {
        syncAgain = false;
        await workers.sync(store.get());
      } while (syncAgain);
    })().catch(() => {
      logger.warn('[pc-boost] Worker settings sync deferred; server remains available.');
    }).finally(() => { syncing = undefined; });
    return syncing;
  };
  const reply = async (_req, res) => {
    if (!store || !workers) return res.status(503).json({ error: 'PC Boost settings unavailable.', code: 'pc_boost_unavailable' });
    try {
      return res.json({ config: store.get(), bounds: CONFIG_BOUNDS, health: await getHealth(),
        boost: { ffmpeg: globalThis.__vfPcFfmpegLimit || 0, clipvault: globalThis.__vfPcClipvaultLimit || 0 } });
    }
    catch { return res.status(503).json({ error: 'PC Boost status unavailable.', code: 'pc_boost_unavailable' }); }
  };
  app.get('/api/pc-boost', requireOwner, reply);
  app.patch('/api/pc-boost', requireOwner, async (req, res) => {
    if (!store || !workers) return reply(req, res);
    try { store.update(req.body); }
    catch (error) {
      return res.status(error.status === 400 ? 400 : 503).json({
        error: error.status === 400 ? error.message : 'PC Boost settings could not be saved.',
        code: error.status === 400 ? 'invalid_config' : 'pc_boost_save_failed',
      });
    }
    // Publication is synchronous; an offline PC never prevents saving the gate.
    void reconcile();
    healthCached = undefined;
    return reply(req, res);
  });
  // v8: extra = the home PC's CPU capacity while it is healthy, so it only changes when the
  // PC comes or goes (every change re-publishes the FFlow runtime). Jobs running on the PC are
  // published as __vfPcBoostActive; the patched scheduler stops counting them as server work,
  // so PC work adds capacity instead of occupying server's slots. server's own FFmpeg work stays
  // capped at its base slots. Three consecutive failed probes withdraw the extra capacity.
  let healthyStreak = 0;
  let failedStreak = 0;
  // ClipVault concurrency follows the home PC: raised while the PC is verified reachable,
  // back to the configured value (Sye: max(configured, this)) as soon as it is not.
  const publishClipvault = limit => {
    if ((globalThis.__vfPcClipvaultLimit || 0) === limit) return;
    globalThis.__vfPcClipvaultLimit = limit;
    logger.info(`[pc-boost] clipvault concurrency ${limit > 0 ? 'raised to ' + limit + ' (home PC reachable)' : 'back to configured value'}`);
    try { globalThis.__vfPcBoostWake?.(); } catch {}
  };
  // FFmpeg follows the same rule (Sye lane + FFlow runtime/worker target: max(configured, this)).
  // Every change re-publishes the FFlow runtime, so FFlow's own limit always equals the lane size.
  const publishFfmpeg = limit => {
    if ((globalThis.__vfPcFfmpegLimit || 0) === limit) return;
    globalThis.__vfPcFfmpegLimit = limit;
    logger.info(`[pc-boost] ffmpeg concurrency ${limit > 0 ? 'boosted to ' + limit + ' (home PC reachable)' : 'back to configured value'}`);
    try { globalThis.__vfPcBoostOnExtra?.(); } catch {}
    try { globalThis.__vfPcBoostWake?.(); } catch {}
  };
  const publishActive = active => {
    const before = globalThis.__vfPcBoostActive || 0;
    globalThis.__vfPcBoostActive = active;
    // Finished PC work frees capacity: admit the next waiter now, not on the next event.
    if (active < before) { try { globalThis.__vfPcBoostWake?.(); } catch {} }
  };
  let probing = false;
  const publishExtra = async () => {
    if (probing) return; // a slow probe (up to 5 s) must not overlap the next 3 s tick
    probing = true;
    try { await probeOnce(); } finally { probing = false; }
  };
  const probeOnce = async () => {
    let extra = globalThis.__vfPcBoostFfmpegExtra || 0;
    try {
      const config = store?.get();
      // Own probe with a 5 s deadline: the home link needs 1-2 s under load, which made the
      // 900 ms UI deadline flap. The UI keeps its short deadline and reuses this result.
      let health;
      if (config?.enabled) {
        health = await workers.health({ deadlineMs: 5000 });
        healthCached = health;
        healthTime = Date.now();
      }
      const ffmpeg = health?.ffmpeg;
      if (!config?.enabled) {
        globalThis.__vfHomeCapabilities = { ready: false, checkedAt: Date.now(), capacity: 0 };
        healthyStreak = 0; failedStreak = 0; extra = 0;
        globalThis.__vfPcSceneSlots = 0;
        publishClipvault(0);
        publishFfmpeg(0);
        publishActive(0);
      } else if (ffmpeg?.reachable && ffmpeg?.ready) {
        healthyStreak += 1; failedStreak = 0;
        const capacity = pcFfmpegCapacity(ffmpeg);
        globalThis.__vfHomeCapabilities = { ready: true, checkedAt: Date.now(),
          capacity: Math.min(50, config.cpuWorkers + (ffmpeg.nvencReady ? config.gpuWorkers : 0)) };
        // v10: off by default. FFlow caps its own active jobs at the same base value
        // (worker.py active_limit = runtime_concurrency()), so extra Node admissions only parked in
        // FFlow's queue and showed the lane above the configured limit. The PC helps inside
        // FFlow's jobs (FFmpeg + scene offload). Re-enable only together with an FFlow-side limit.
        if (healthyStreak >= 2) extra = process.env.VF_PC_BOOST_SCHEDULER_EXTRA === '1' ? capacity : 0;
        publishActive(pcFfmpegActive(ffmpeg));
        // Own PC capacity for scene detection (v11 PC lane), only while the PC is verified healthy.
        if (healthyStreak >= 2) globalThis.__vfPcSceneSlots = ffmpeg.sceneReady ? Math.min(25, ffmpeg.sceneCapacity || 0) : 0;
        if (healthyStreak >= 2) publishClipvault(config.clipvaultBoost || 0);
        if (healthyStreak >= 2) publishFfmpeg(config.ffmpegBoost || 0);
      } else {
        healthyStreak = 0; failedStreak += 1;
        // One probe lost to a loaded server's event loop must not stop Home dispatch: the
        // capabilities fall to "not ready" only after 3 failures in a row (like the boosts).
        if (failedStreak >= 3) {
          globalThis.__vfHomeCapabilities = { ready: false, checkedAt: Date.now(), capacity: 0 };
          extra = 0; publishActive(0); globalThis.__vfPcSceneSlots = 0; publishClipvault(0); publishFfmpeg(0);
        }
      }
    } catch {
      healthyStreak = 0; failedStreak += 1;
      if (failedStreak >= 3) {
        globalThis.__vfHomeCapabilities = { ready: false, checkedAt: Date.now(), capacity: 0 };
        extra = 0; publishActive(0); globalThis.__vfPcSceneSlots = 0; publishClipvault(0); publishFfmpeg(0);
      }
    }
    extra = Math.max(0, Math.min(25, extra));
    if (globalThis.__vfPcBoostFfmpegExtra !== extra) {
      globalThis.__vfPcBoostFfmpegExtra = extra;
      logger.info(`[pc-boost] home FFmpeg scheduler extra=${extra}`);
      try { globalThis.__vfPcBoostOnExtra?.(); } catch {}
    }
  };
  // 3 s: finished PC jobs are noticed quickly; the probe is a tiny request over the tunnel.
  const extraTimer = reconcileIntervalMs > 0 ? setInterval(() => { void publishExtra(); }, 3000) : undefined;
  extraTimer?.unref();
  if (reconcileIntervalMs > 0) void publishExtra();
  const timer = reconcileIntervalMs > 0 ? setInterval(reconcile, reconcileIntervalMs) : undefined;
  timer?.unref();
  if (reconcileIntervalMs > 0) void reconcile();
  return { reconcile, close: () => { clearInterval(timer); clearInterval(extraTimer); }, store };
}
