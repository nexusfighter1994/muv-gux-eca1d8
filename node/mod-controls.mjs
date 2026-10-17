import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GROUPS, MODS } from './mod-registry.mjs';

const RECORD = 'vf_mods';
const ROUTE = '/api/vf-custom/mods';
const RUNTIME = '/data/runtime/vf-mods-active.json';
const INSTALLATION = Symbol.for('vf.custom.modControls');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const definitions = new Map(MODS.map(mod => [mod.id, mod]));
const defaults = Object.freeze(Object.fromEntries(MODS.filter(mod => !mod.readOnly).map(mod => [mod.id, true])));
let bootSnapshot = null;
let installedApp = null;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'invalid_mods' });

function validateFlags(flags, { allowEmpty = false } = {}) {
  if (!plain(flags) || (!allowEmpty && Object.keys(flags).length === 0)) {
    throw invalid('changes must be a non-empty object of mod IDs and boolean values.');
  }
  for (const [id, enabled] of Object.entries(flags)) {
    const definition = definitions.get(id);
    if (!definition) throw invalid(`Unknown custom mod: ${id}.`);
    if (definition.readOnly) throw invalid(`${id} is always on: ${definition.alwaysOnReason}`);
    if (typeof enabled !== 'boolean') throw invalid(`${id} must be true or false.`);
  }
  return { ...flags };
}

function readDesired(db) {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(RECORD);
  if (!row) return { version: 1, revision: null, changedAt: null, mods: { ...defaults } };
  const state = JSON.parse(row.value_json);
  if (!plain(state) || Object.keys(state).length !== 4
    || !['version', 'revision', 'changedAt', 'mods'].every(key => Object.hasOwn(state, key))
    || state.version !== 1 || typeof state.revision !== 'string' || !UUID.test(state.revision)
    || typeof state.changedAt !== 'string' || !Number.isFinite(Date.parse(state.changedAt))) {
    throw new Error('Invalid persisted vf_mods record; settings were not replaced.');
  }
  return { version: 1, revision: state.revision, changedAt: state.changedAt,
    mods: { ...defaults, ...validateFlags(state.mods, { allowEmpty: true }) } };
}

function publishActive(runtimePath, state) {
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
  const temporary = `${runtimePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, runtimePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function modEnabled(id) {
  const definition = definitions.get(id);
  if (!definition) throw new Error(`Unknown custom mod: ${String(id)}. Check MODS for supported IDs.`);
  if (!bootSnapshot) throw new Error('Call installModControls before modEnabled; the boot snapshot is not installed.');
  return definition.readOnly || bootSnapshot.mods[id];
}

export function installModControls({ app, db, requireOwner, runtimePath = RUNTIME, loadBootSnapshot }) {
  if (installedApp === app && app[INSTALLATION]) return app[INSTALLATION];
  if (installedApp || app[INSTALLATION]) throw new Error('Mod controls are already installed; the boot snapshot cannot be replaced.');
  if (typeof requireOwner !== 'function' || typeof app.get !== 'function' || typeof app.patch !== 'function') {
    throw new TypeError('Mod controls require an app and owner middleware.');
  }
  const generationLoader = loadBootSnapshot || (process.env.VF_MODS_BOOTSTRAP === '1'
    ? file => JSON.parse(execFileSync('python', ['/app/engines/fflow/src/core/mod_boot.py', '--runtime', file],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 65536, windowsHide: true })) : null);
  let effective;
  if (generationLoader) {
    const loaded = generationLoader(runtimePath);
    if (!plain(loaded) || loaded.version !== 1 || typeof loaded.generation !== 'string' || !loaded.generation) {
      throw new Error('Invalid generation mod snapshot; refusing to install controls.');
    }
    effective = { ...loaded, mods: { ...defaults, ...validateFlags(loaded.mods, { allowEmpty: true }) } };
  } else effective = readDesired(db);
  Object.freeze(effective.mods);
  Object.freeze(effective);
  if (!generationLoader) publishActive(runtimePath, effective);

  const describe = desired => ({
    revision: desired.revision,
    groups: GROUPS,
    mods: MODS.map(definition => {
      const enabled = definition.readOnly || desired.mods[definition.id];
      const active = definition.readOnly || effective.mods[definition.id];
      return { ...definition, enabled, effective: active, pendingRestart: enabled !== active };
    }),
    changedAt: desired.changedAt,
  });
  const snapshot = () => describe(readDesired(db));
  const save = db.transaction(patch => {
    const current = readDesired(db);
    if (patch.revision !== current.revision) {
      throw Object.assign(new Error('Mod settings changed. Reload before saving.'), {
        status: 409, code: 'revision_conflict', revision: current.revision,
      });
    }
    if (Object.entries(patch.changes).every(([id, value]) => current.mods[id] === value)) return current;
    const next = { version: 1, revision: randomUUID(), changedAt: new Date().toISOString(),
      mods: { ...current.mods, ...patch.changes } };
    db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(RECORD, JSON.stringify(next));
    return next;
  });
  const unavailable = res => res.status(503).json({ error: 'Custom mod settings unavailable.', code: 'mods_unavailable' });

  app.get(ROUTE, requireOwner, (_req, res) => {
    try { return res.json(snapshot()); } catch { return unavailable(res); }
  });
  app.patch(ROUTE, requireOwner, (req, res) => {
    let patch;
    try {
      const body = req.body;
      if (!plain(body) || Object.keys(body).length !== 2
        || !Object.hasOwn(body, 'revision') || !Object.hasOwn(body, 'changes')
        || !(body.revision === null || typeof body.revision === 'string' && UUID.test(body.revision))) {
        throw invalid('Use exactly revision (UUID or null) and changes (mod ID booleans).');
      }
      patch = { revision: body.revision, changes: validateFlags(body.changes) };
    } catch (error) {
      return res.status(400).json({ error: error.message, code: 'invalid_mods' });
    }
    try {
      // Lock before reading the revision so other SQLite connections cannot race this save.
      const next = typeof save.immediate === 'function' ? save.immediate(patch) : save(patch);
      return res.json(describe(next));
    } catch (error) {
      if (error.status === 409 && error.code === 'revision_conflict') {
        return res.status(409).json({ error: error.message, code: error.code, revision: error.revision });
      }
      return unavailable(res);
    }
  });
  bootSnapshot = effective;
  installedApp = app;
  return app[INSTALLATION] = Object.freeze({ snapshot });
}
