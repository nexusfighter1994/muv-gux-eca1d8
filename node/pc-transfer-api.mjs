import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_TRANSFER_LIMITS = Object.freeze({
  ffmpegMaxFileMb: 64, ffmpegMaxTotalMb: 96, sceneMaxFileMb: 400, siglipMaxImageMb: 20,
});
export const TRANSFER_BOUNDS = Object.freeze(Object.fromEntries(Object.keys(DEFAULT_TRANSFER_LIMITS)
  .map(key => [key, Object.freeze({ min: 1, max: key === 'siglipMaxImageMb' ? 128 : 4096 })])));
const KEYS = Object.keys(DEFAULT_TRANSFER_LIMITS);
const RECORD = 'pc_boost_transfer_limits';
const RUNTIME = '/data/runtime/pc-transfer-limits.json';
const TOKEN = '/data/runtime/pc-boost-token';
const ROUTE = '/api/pc-boost/transfer-limits';
const UUID = /^[0-9a-f-]{36}$/;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const invalid = message => Object.assign(new Error(message), { status: 400 });
const INSTALLATION = Symbol.for('vf.pcBoost.transferLimits');
const SENDER_STATE = Symbol.for('vf.pcBoost.transferSenderActivation');
const SENDER_OVERLAY = Symbol.for('vf.pcBoost.transferSenderOverlay');

function senderActivation(value) {
  // Scalar readiness describes the cached FFlow senders; SigLIP is separate.
  if (typeof value === 'boolean') return { ffmpeg: value, scenes: value, siglip: true };
  const keys = ['ffmpeg', 'scenes', 'siglip'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !own(value, key) || typeof value[key] !== 'boolean')) {
    throw invalid('Sender readiness must contain three explicit boolean capabilities.');
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function withSenderReadiness(body, activation) {
  if (!body || typeof body !== 'object' || !body.limits || typeof body.configured !== 'boolean' || typeof body.status !== 'string') return body;
  const receiverStatus = body.receiverStatus || (body.status === 'server_reload_pending' ? 'pending' : body.status);
  return { ...body, receiverStatus, senderActivation: { ...activation },
    status: body.configured && Object.values(activation).some(ready => !ready) ? 'server_reload_pending' : receiverStatus };
}

function installSenderOverlay(app, control, initial) {
  const activation = initial === undefined ? null : senderActivation(initial);
  let state = app[SENDER_STATE];
  if (!state) {
    state = app[SENDER_STATE] = { activation: activation || senderActivation(true), baseSnapshot: control.snapshot.bind(control) };
    control.snapshot = () => withSenderReadiness(state.baseSnapshot(), state.activation);
  } else if (activation) state.activation = activation;
  control.markSenderReady = ready => markSenderReady(app, ready);

  // Old installed handlers retain their original snapshot closure. Overlay only
  // their final JSON response, leaving owner/CSRF guards and save logic untouched.
  const stack = app._router?.stack || app.router?.stack;
  for (const route of Array.isArray(stack) ? stack : []) {
    if (route.route?.path !== ROUTE || !Array.isArray(route.route.stack)) continue;
    const layer = route.route.stack.at(-1);
    if (!layer || typeof layer.handle !== 'function' || layer.handle[SENDER_OVERLAY]) continue;
    const original = layer.handle;
    const wrapped = function (req, res, next) {
      const json = res.json;
      const overlay = function (body) {
        this.json = json;
        return json.call(this, (this.statusCode ?? 200) < 400 ? withSenderReadiness(body, state.activation) : body);
      };
      res.json = overlay;
      let asynchronous = false;
      const restore = () => { if (res.json === overlay) res.json = json; };
      try {
        const result = original.call(this, req, res, next);
        if (result && typeof result.then === 'function') {
          asynchronous = true;
          return Promise.resolve(result).finally(restore);
        }
        return result;
      } finally { if (!asynchronous) restore(); }
    };
    wrapped[SENDER_OVERLAY] = true;
    layer.handle = wrapped;
  }
  return control;
}

export function markSenderReady(app, ready) {
  const control = app[INSTALLATION];
  if (!control || typeof control.snapshot !== 'function') throw new Error('Transfer controls are not installed.');
  return installSenderOverlay(app, control, ready).snapshot();
}

export function validateTransferLimits(patch, current = DEFAULT_TRANSFER_LIMITS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
    || Object.keys(patch).some(key => !own(DEFAULT_TRANSFER_LIMITS, key))) {
    throw invalid('Use only the four supported offload size limits.');
  }
  const limits = { ...current, ...patch };
  if (Object.keys(limits).length !== KEYS.length) throw invalid('Invalid current transfer limits.');
  for (const key of KEYS) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > TRANSFER_BOUNDS[key].max) {
      throw invalid(`${key} must be a whole number from 1 to ${TRANSFER_BOUNDS[key].max} MiB.`);
    }
  }
  return Object.fromEntries(KEYS.map(key => [key, limits[key]]));
}

function fullLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== KEYS.length || KEYS.some(key => !own(value, key))) {
    throw invalid('Incomplete transfer-limit readback.');
  }
  return validateTransferLimits(value);
}

export function writeTransferRuntime(runtimePath, state) {
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
  const temporary = `${runtimePath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ ...state.limits, revision: state.revision })}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, runtimePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function readTransferRuntime(runtimePath = RUNTIME) {
  try {
    const file = fs.lstatSync(runtimePath);
    if (!file.isFile() || file.size <= 0 || file.size > 8192) throw new Error('Invalid transfer-limit runtime file');
    const saved = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)
      || Object.keys(saved).length !== KEYS.length + 1
      || typeof saved.revision !== 'string' || !UUID.test(saved.revision)) throw new Error('Invalid runtime transfer limits');
    return { limits: fullLimits(Object.fromEntries(KEYS.map(key => [key, saved[key]]))), revision: saved.revision, configured: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { limits: { ...DEFAULT_TRANSFER_LIMITS }, revision: null, configured: false };
    throw error;
  }
}

export function createTransferStore({ db, runtimePath = RUNTIME, writeRuntime = writeTransferRuntime }) {
  const select = db.prepare('SELECT value_json FROM app_settings WHERE key = ?');
  const write = db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json');
  let current = { limits: { ...DEFAULT_TRANSFER_LIMITS }, revision: null, configured: false };
  const row = select.get(RECORD);
  if (row) {
    const saved = JSON.parse(row.value_json);
    if (!saved || Object.keys(saved).length !== 2 || typeof saved.revision !== 'string' || !UUID.test(saved.revision)) throw new Error('Invalid stored transfer limits');
    current = { limits: fullLimits(saved.limits), revision: saved.revision, configured: true };
    writeRuntime(runtimePath, current);
  } else current = readTransferRuntime(runtimePath);
  return {
    get: () => ({ ...current, limits: { ...current.limits } }),
    update(patch) {
      const next = { limits: validateTransferLimits(patch, current.limits), revision: randomUUID(), configured: true };
      const previousRuntime = fs.existsSync(runtimePath) ? fs.readFileSync(runtimePath) : null;
      let published = false;
      try {
        db.transaction(() => {
          write.run(RECORD, JSON.stringify({ limits: next.limits, revision: next.revision }));
          writeRuntime(runtimePath, next);
          published = true;
        })();
      } catch (error) {
        if (published) {
          if (previousRuntime) {
            const old = JSON.parse(previousRuntime.toString('utf8'));
            writeTransferRuntime(runtimePath, { limits: fullLimits(Object.fromEntries(KEYS.map(key => [key, old[key]]))), revision: old.revision });
          } else fs.unlinkSync(runtimePath);
        }
        throw error;
      }
      current = next;
      return this.get();
    },
  };
}

function workerUrl(value, port) {
  const url = new URL(value || `http://10.0.3.1:${port}`);
  if (url.protocol !== 'http:' || !['10.0.3.1', '127.0.0.1'].includes(url.hostname) || url.port !== String(port)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid private worker address');
  return url.origin;
}

export function createTransferWorkerClient({ fetchImpl = globalThis.fetch, timeoutMs = 2500,
  readToken = () => fs.readFileSync(TOKEN, 'utf8').trim(),
  ffmpegUrl = process.env.VF_PC_BOOST_FFMPEG_URL, siglipUrl = process.env.VF_PC_BOOST_SIGLIP_URL } = {}) {
  const urls = { ffmpeg: workerUrl(ffmpegUrl, 18191), siglip: workerUrl(siglipUrl, 18194) };
  async function request(kind, method, limits) {
    let token;
    try {
      token = readToken();
      if (typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Unavailable');
    } catch { return { ok: false, reason: 'authentication_unavailable' }; }
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, reason: 'timeout' }); }, timeoutMs);
    });
    const operation = (async () => {
      try {
        const response = await fetchImpl(`${urls[kind]}/transfer-limits`, { method, redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(limits ? { 'content-type': 'application/json' } : {}) },
          ...(limits ? { body: JSON.stringify(limits) } : {}) });
        if (!response.ok) {
          await response.body?.cancel();
          return { ok: false, reason: response.status === 404 ? 'unsupported' : 'worker_rejected' };
        }
        const reader = response.body?.getReader();
        if (!reader) return { ok: false, reason: 'invalid_response' };
        let size = 0;
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16384) { await reader.cancel(); throw new Error('Oversized response'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return { ok: true, limits: fullLimits(body.limits) };
      } catch { return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'invalid_response' }; }
    })();
    try { return await Promise.race([operation, deadline]); } finally { clearTimeout(timer); }
  }
  async function both(method, limits) {
    const [ffmpeg, siglip] = await Promise.all(['ffmpeg', 'siglip'].map(kind => request(kind, method, limits)));
    return { ffmpeg, siglip };
  }
  return { read: () => both('GET'), syncTransfer: limits => both('PUT', fullLimits(limits)) };
}

export function positionTransferRoutes(app) {
  const stack = app._router?.stack || app.router?.stack;
  if (!Array.isArray(stack)) return;
  const terminal = stack.find(layer => !layer.route && typeof layer.handle === 'function'
    && String(layer.handle).includes('404') && String(layer.handle).includes('Not found'));
  if (!terminal) return;
  const routes = stack.filter(layer => layer.route?.path === ROUTE);
  for (const layer of routes) stack.splice(stack.indexOf(layer), 1);
  stack.splice(stack.indexOf(terminal), 0, ...routes);
}

export function installTransferControls(options) {
  const { app, db, requireOwner, runtimePath = RUNTIME,
    workerClient, logger = console, now = Date.now, startTimer = true, senderReady = true } = options;
  const key = INSTALLATION;
  if (app[key]) {
    positionTransferRoutes(app);
    return installSenderOverlay(app, app[key], own(options, 'senderReady') ? senderReady : undefined);
  }
  const initialActivation = senderActivation(senderReady);
  const decorate = body => withSenderReadiness(body, app[SENDER_STATE]?.activation || initialActivation);
  let store, workers;
  try {
    store = createTransferStore({ db, runtimePath });
    workers = workerClient || createTransferWorkerClient();
  } catch { logger.error('[pc-transfer] Size settings unavailable; existing state retained.'); }
  let observed, checkedAt = 0, pending, closed = false;
  const sanitize = result => Object.fromEntries(['ffmpeg', 'siglip'].map(kind => {
    let limits = null;
    try { if (result?.[kind]?.ok === true) limits = fullLimits(result[kind].limits); } catch {}
    return [kind, { observed: limits, reason: limits ? 'readback' : 'unavailable' }];
  }));
  const snapshot = () => {
    const state = store.get();
    const fresh = observed && now() - checkedAt <= 35000;
    const readback = fresh ? observed : sanitize(null);
    const matched = kind => readback[kind].observed && KEYS.every(key => readback[kind].observed[key] === state.limits[key]);
    const available = ['ffmpeg', 'siglip'].filter(kind => readback[kind].observed).length;
    return { ...state, bounds: TRANSFER_BOUNDS, units: 'MiB', workers: readback,
      checkedAt: fresh ? new Date(checkedAt).toISOString() : null,
      status: !state.configured ? 'defaults' : matched('ffmpeg') && matched('siglip') ? 'active' : available ? 'pending' : 'worker_offline' };
  };
  function reconcile() {
    if (pending) return pending;
    if (!store || !workers || closed) return Promise.resolve();
    pending = (async () => {
      try {
        const state = store.get();
        let actual = sanitize(await workers.read());
        if (state.configured && !['ffmpeg', 'siglip'].every(kind => actual[kind].observed
          && KEYS.every(key => actual[kind].observed[key] === state.limits[key]))) {
          await workers.syncTransfer(state.limits);
          actual = sanitize(await workers.read());
        }
        if (!closed) { observed = actual; checkedAt = now(); }
      } catch { if (!closed) { observed = sanitize(null); checkedAt = now(); } }
    })().finally(() => { pending = null; });
    return pending;
  }
  const unavailable = res => res.status(503).json({ error: 'Offload size settings unavailable.', code: 'transfer_limits_unavailable' });
  app.get(ROUTE, requireOwner, (_req, res) => store ? res.json(decorate(snapshot())) : unavailable(res));
  app.patch(ROUTE, requireOwner, (req, res) => {
    if (!store) return unavailable(res);
    try {
      store.update(req.body);
      res.json(decorate({ ...snapshot(), status: 'pending' }));
      if (startTimer) void reconcile();
    } catch (error) {
      return res.status(error.status === 400 ? 400 : 503).json({ error: error.status === 400 ? error.message : 'Offload size limits could not be saved.',
        code: error.status === 400 ? 'invalid_config' : 'transfer_limits_save_failed' });
    }
  });
  positionTransferRoutes(app);
  const timer = startTimer ? setInterval(() => void reconcile(), 15000) : null;
  timer?.unref();
  if (startTimer) void reconcile();
  const control = app[key] = { store, snapshot, reconcile, close() { closed = true; if (timer) clearInterval(timer); } };
  return installSenderOverlay(app, control, initialActivation);
}
