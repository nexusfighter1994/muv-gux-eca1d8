'use strict';
// Main-thread relief for native ffmpeg/ffprobe execs.
//
// libuv spawns with fork(): the cost grows with the parent's RSS. In the live container a
// spawn blocked the event loop 220 ms (median) at 1.5 GB RSS vs 2.7 ms at 44 MB, so ~3
// ffmpeg/ffprobe execs per second took 33-60% of the VidForge main thread. Calls with the
// exact native exec shape (qAt: ffmpeg/ffprobe, stdio ['ignore','pipe','pipe'], no other
// option) are spawned by a small helper process instead; everything else, and every call
// while the helper is unavailable, uses the original spawn.
const childProcess = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { AsyncResource } = require('node:async_hooks');
const diagnostics = require('node:diagnostics_channel');

const HELPER = path.join(__dirname, 'spawn-helper.cjs');
const BINARIES = new Set(['ffmpeg', 'ffprobe']);
const SPAWN_CHANNEL = 'vidforge:child-process-spawn';

function nativeShape(file, args, options) {
  if (typeof file !== 'string' || !Array.isArray(args) || !options || typeof options !== 'object') return false;
  const base = path.basename(file).replace(/\.exe$/i, '');
  if (!BINARIES.has(base)) return false;
  const keys = Object.keys(options);
  const stdio = options.stdio;
  return keys.length === 1 && keys[0] === 'stdio' && Array.isArray(stdio) && stdio.length === 3
    && stdio[0] === 'ignore' && stdio[1] === 'pipe' && stdio[2] === 'pipe'
    && args.every(a => typeof a === 'string');
}

class ProxyChild extends EventEmitter {
  constructor(file, args, proxy, id) {
    super();
    this.pid = undefined;
    this.stdin = null;
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.stdio = [null, this.stdout, this.stderr];
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.connected = false;
    this.spawnfile = file;
    this.spawnargs = [file, ...args];
    this._proxy = proxy;
    this._id = id;
    this._pendingKill = null;
    this._closed = false;
  }
  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null || this._closed) return false;
    this.killed = true;
    if (this.pid === undefined) { this._pendingKill = signal; return true; }
    return this._proxy._send({ op: 'kill', id: this._id, signal });
  }
  ref() {}
  unref() {}
}

function createSpawnProxy({ originalSpawn = childProcess.spawn, fork = childProcess.fork, helperPath = HELPER,
  publish = message => diagnostics.channel(SPAWN_CHANNEL).publish(message), retryMs = 60000, now = Date.now,
  match = nativeShape, unref = true } = {}) {
  const stats = { proxied: 0, native: 0, helperStarts: 0, helperExits: 0, lastError: null };
  const children = new Map();
  let helper = null, ready = false, nextId = 1, downUntil = 0;

  function startHelper() {
    stats.helperStarts++;
    const h = fork(helperPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced', execArgv: [] });
    helper = h; ready = true; stats.helperPid = h.pid;
    h.on('message', onMessage);
    h.once('exit', (code, signal) => onHelperExit(h, `spawn helper exited (${code ?? signal})`));
    h.once('error', error => onHelperExit(h, String(error?.message || error)));
    if (unref) { h.unref(); h.channel?.unref?.(); }
  }

  function onHelperExit(h, reason) {
    if (helper !== h) return;
    stats.helperExits++; stats.lastError = reason;
    helper = null; ready = false; downUntil = now() + retryMs;
    for (const child of children.values()) fail(child, Object.assign(new Error(reason), { code: 'ESPAWNHELPER' }));
    children.clear();
  }

  function fail(child, error) {
    if (child._closed) return;
    // A caller that already saw this exec's error (spawn failure) has no listener left.
    if (child.listenerCount('error') > 0) child.emit('error', error);
    finish(child, null, 'SIGKILL');
  }

  function finish(child, code, signal) {
    if (child._closed) return;
    child._closed = true;
    // Like native: a process that never started emits 'error' and 'close', but no 'exit'.
    if (child.exitCode === null && child.signalCode === null && !child._spawnFailed) {
      child.exitCode = code; child.signalCode = signal;
      child.emit('exit', code, signal);
    }
    child.stdout.push(null); child.stderr.push(null);
    // Like native: 'close' after the stdio streams that are being read have ended.
    const ended = s => (s.readableEnded || s.readableFlowing !== true ? Promise.resolve() : new Promise(r => s.once('end', r)));
    Promise.all([ended(child.stdout), ended(child.stderr)]).then(() => setImmediate(() => child.emit('close', code, signal)));
  }

  function onMessage(message) {
    const child = children.get(message?.id);
    if (!child) return;
    switch (message.op) {
      case 'spawned':
        child.pid = message.pid;
        child._published?.(message.pid);
        child.emit('spawn');
        if (child._pendingKill) { const s = child._pendingKill; child._pendingKill = null; proxy._send({ op: 'kill', id: child._id, signal: s }); }
        break;
      case 'data': { const c = message.chunk; (message.fd === 2 ? child.stderr : child.stdout).push(Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength)); break; }
      case 'error': {
        const e = message.error || {};
        if (child.pid === undefined) child._spawnFailed = true;
        child.emit('error', Object.assign(new Error(e.message || 'spawn failed'), { code: e.code, errno: e.errno, syscall: e.syscall, path: e.path, spawnargs: e.spawnargs }));
        break;
      }
      case 'exit':
        child.exitCode = message.code; child.signalCode = message.signal;
        child.emit('exit', message.code, message.signal);
        break;
      case 'close': children.delete(child._id); finish(child, message.code, message.signal); break;
      default: break;
    }
  }

  const proxy = {
    stats,
    _send(message) { try { return !!helper && helper.send(message) !== false; } catch { return false; } },
    spawn(file, args, options) {
      if (!match(file, args, options) || now() < downUntil) { stats.native++; return originalSpawn(file, args, options); }
      if (!ready) {
        try { startHelper(); } catch (error) { stats.lastError = String(error?.message || error); downUntil = now() + retryMs; stats.native++; return originalSpawn(file, args, options); }
      }
      const id = nextId++;
      const child = new ProxyChild(file, args, proxy, id);
      // The native exec only publishes a pid it has synchronously; publish it here in the
      // caller's async context so per-job process accounting still sees the process.
      child._published = AsyncResource.bind(pid => { try { publish({ pid, engine: 'ffmpeg' }); } catch { /* accounting only */ } });
      children.set(id, child);
      if (!proxy._send({ op: 'spawn', id, file, args })) {
        children.delete(id); stats.native++;
        return originalSpawn(file, args, options);
      }
      stats.proxied++;
      return child;
    },
    close() { const h = helper; if (h) { onHelperExit(h, 'spawn helper closed'); try { h.kill(); } catch { /* gone */ } } },
  };
  return proxy;
}

// Install for the whole process: CJS `require('child_process').spawn` and, through
// syncBuiltinESMExports, every ESM `import {spawn} from 'node:child_process'` binding.
function install(options = {}) {
  if (childProcess.spawn.__vfSpawnProxy) return childProcess.spawn.__vfSpawnProxy;
  const original = childProcess.spawn;
  const proxy = createSpawnProxy({ originalSpawn: original, ...options });
  const spawn = function spawn(file, args, opts) { return proxy.spawn(file, args, opts); };
  spawn.__vfSpawnProxy = proxy;
  spawn.original = original;
  childProcess.spawn = spawn;
  require('node:module').syncBuiltinESMExports();
  globalThis.__vfSpawnProxy = proxy;
  return proxy;
}

function uninstall() {
  const current = childProcess.spawn;
  if (!current.__vfSpawnProxy) return false;
  childProcess.spawn = current.original;
  require('node:module').syncBuiltinESMExports();
  current.__vfSpawnProxy.close();
  return true;
}

module.exports = { createSpawnProxy, install, uninstall, nativeShape, ProxyChild, SPAWN_CHANNEL };
