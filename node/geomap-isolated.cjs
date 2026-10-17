const { spawn } = require('node:child_process');
const path = require('node:path');

const stats = { active: 0, completed: 0, failed: 0, timeouts: 0, lastAt: null };

function createIsolatedMapRenderer({ workerPath = path.join(__dirname, 'geomap-worker.mjs'),
  timeoutMs = 900000, cleanupMs = 5000, spawnImpl = spawn,
  killImpl = (pid, signal) => process.kill(-pid, signal) } = {}) {
  let tail = Promise.resolve();
  function run(options) {
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      if (signal?.aborted) { reject(signal.reason || new Error('GeoMap render aborted')); return; }
      let child;
      let finished = false;
      let result;
      let failure;
      let closeTimer;
      let closed = false;
      let groupKilled = false;
      let stderr = '';
      let phase = 'map_init';
      const killGroup = () => {
        if (groupKilled || !child?.pid) return;
        groupKilled = true;
        try { killImpl(child.pid, 'SIGKILL'); } catch {}
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(closeTimer);
        signal?.removeEventListener('abort', onAbort);
        stats.active -= 1;
        stats.lastAt = new Date().toISOString();
        if (failure) { stats.failed += 1; reject(failure); }
        else if (result) { stats.completed += 1; resolve(result); }
        else { stats.failed += 1; reject(new Error('GeoMap worker exited without a result')); }
      };
      const stop = error => {
        if (finished || failure) return;
        failure = error;
        killGroup();
        if (closed) finish();
        else closeTimer = setTimeout(finish, cleanupMs);
      };
      const timedOut = () => {
        stats.timeouts += 1;
        const error = new Error(`GeoMap isolated render timed out after ${timeoutMs}ms`);
        error.code = 'geomap_render_timeout';
        error.timeoutMs = timeoutMs;
        error.phase = phase;
        stop(error);
      };
      const timer = setTimeout(timedOut, timeoutMs);
      const onAbort = () => stop(signal.reason || new Error('GeoMap render aborted'));
      stats.active += 1;
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        child = spawnImpl(process.execPath, [workerPath], {
          detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { ...process.env, VIDFORGE_GEOMAP_ISOLATED_CHILD: '1' },
        });
        child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-2000); });
        child.on('message', message => {
          if (finished || failure) return;
          if (message.type === 'phase') {
            phase = message.value;
            try { options.onPhase?.(phase); } catch {}
          } else if (message.type === 'progress') {
            try { options.onProgress?.(message.value); } catch {}
          } else if (message.type === 'result') {
            if (message.value?.outputPath !== options.targetPath || !(message.value?.fileSize > 0)) {
              stop(new Error('GeoMap worker returned an invalid output artifact')); return;
            }
            result = message.value;
          } else if (message.type === 'error') {
            const error = new Error(message.message || 'GeoMap worker failed');
            if (message.code) error.code = message.code;
            if (message.phase) error.phase = message.phase;
            stop(error);
          }
        });
        child.on('error', stop);
        child.on('exit', (code, signalName) => {
          closed = true;
          if (!failure && (code !== 0 || !result)) {
            failure = new Error(`GeoMap worker exited (${signalName || code}): ${stderr || 'no result'}`);
          }
          // Also clean up ffmpeg children if the worker itself crashed.
          if (failure) killGroup();
          finish();
        });
        const { onPhase, onProgress, signal: _signal, ...payload } = options;
        child.send({ type: 'render', options: payload }, error => { if (error) stop(error); });
      } catch (error) {
        closed = !child;
        stop(error);
      }
    });
  }
  const render = options => {
    const next = tail.then(() => run(options));
    tail = next.catch(() => undefined);
    return next;
  };
  render.isolationVersion = 'cartograph-process-v1';
  return render;
}

module.exports = { createIsolatedMapRenderer, stats };
