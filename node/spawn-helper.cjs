'use strict';
// Small-RSS spawn helper (see spawn-proxy.cjs). Spawns exactly what the main process asks
// for and streams stdout/stderr/exit back over IPC. Exits (killing its children) when the
// main process goes away.
const { spawn } = require('node:child_process');

const children = new Map();
const send = message => { try { process.send(message); } catch { /* main gone */ } };

process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.op === 'kill') {
    const child = children.get(message.id);
    if (child) { try { child.kill(message.signal || 'SIGTERM'); } catch { /* already gone */ } }
    return;
  }
  if (message.op !== 'spawn') return;
  const { id, file, args } = message;
  let child;
  try {
    child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    send({ op: 'error', id, error: plain(error) });
    send({ op: 'close', id, code: null, signal: null });
    return;
  }
  children.set(id, child);
  child.once('spawn', () => send({ op: 'spawned', id, pid: child.pid }));
  child.stdout.on('data', chunk => send({ op: 'data', id, fd: 1, chunk }));
  child.stderr.on('data', chunk => send({ op: 'data', id, fd: 2, chunk }));
  child.once('error', error => send({ op: 'error', id, error: plain(error) }));
  child.once('exit', (code, signal) => send({ op: 'exit', id, code, signal }));
  child.once('close', (code, signal) => { children.delete(id); send({ op: 'close', id, code, signal }); });
});

function plain(error) {
  return { message: String(error?.message || error), code: error?.code, errno: error?.errno, syscall: error?.syscall,
    path: error?.path, spawnargs: error?.spawnargs };
}

process.on('disconnect', () => {
  for (const child of children.values()) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(0);
});
send({ op: 'ready', pid: process.pid });
