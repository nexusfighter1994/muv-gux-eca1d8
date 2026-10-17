const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createIsolatedMapRenderer } = require('./geomap-isolated.cjs');

function fixture(behavior, timeoutMs = 100) {
  const children = [];
  const kills = [];
  const spawnImpl = (_file, args, config) => {
    const child = new EventEmitter();
    child.pid = 100 + children.length;
    child.stderr = new EventEmitter();
    child.send = (request, callback) => { child.request = request; callback(); behavior(child, children.length); };
    children.push(child);
    child.config = config;
    child.args = args;
    return child;
  };
  const killImpl = (pid, signal) => {
    kills.push({ pid, signal });
    const child = children.find(value => value.pid === pid);
    queueMicrotask(() => child.emit('exit', null, signal));
  };
  return { render: createIsolatedMapRenderer({ spawnImpl, killImpl, timeoutMs, cleanupMs: 15 }), children, kills };
}
const options = { targetPath: '/tmp/test-map.mp4', params: { frames: 24, fps: 24 } };
function succeed(child) {
  queueMicrotask(() => {
    child.emit('message', { type: 'result', value: { outputPath: child.request.options.targetPath, fileSize: 1000 } });
    child.emit('exit', 0);
  });
}
test('successful map preserves options and strips functions and signals from IPC', async () => {
  const f = fixture(succeed);
  const result = await f.render({ ...options, onProgress() {}, signal: new AbortController().signal });
  assert.equal(result.outputPath, options.targetPath);
  assert.deepEqual(f.children[0].request.options, options);
  assert.equal(f.children[0].config.env.VIDFORGE_GEOMAP_ISOLATED_CHILD, '1');
  assert.equal(f.children[0].config.detached, true);
  assert.equal(f.kills.length, 0);
});
test('a hung map is killed and the following map can finish', async () => {
  const f = fixture((child, count) => { if (count > 1) succeed(child); }, 15);
  const first = f.render(options);
  const next = f.render({ ...options, targetPath: '/tmp/next.mp4' });
  await assert.rejects(first, error => error.code === 'geomap_render_timeout');
  assert.equal((await next).outputPath, '/tmp/next.mp4');
  assert.ok(f.kills.some(value => value.pid === 100 && value.signal === 'SIGKILL'));
});
test('abort kills only the map process group and releases its queue', async () => {
  const controller = new AbortController();
  const reason = new Error('exact caller cancelled');
  const f = fixture((child, count) => { if (count > 1) succeed(child); });
  const first = f.render({ ...options, signal: controller.signal });
  const next = f.render(options);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(first, error => error === reason);
  await next;
  assert.ok(f.kills.every(value => value.pid === 100));
});
test('cancelled queued map never spawns a child', async () => {
  let release;
  const f = fixture((child, count) => { if (count === 1) release = () => succeed(child); else succeed(child); });
  const first = f.render(options);
  const controller = new AbortController();
  const next = f.render({ ...options, signal: controller.signal });
  const rejected = assert.rejects(next, /cancelled/);
  controller.abort(new Error('cancelled'));
  await new Promise(resolve => setImmediate(resolve));
  release();
  await first;
  await rejected;
  assert.equal(f.children.length, 1);
});
test('crashed worker without a result fails once and cleans up its ffmpeg group', async () => {
  const f = fixture(child => queueMicrotask(() => child.emit('exit', 1)));
  await assert.rejects(f.render(options), /worker exited/);
  assert.equal(f.children.length, 1);
  assert.ok(f.kills.length > 0);
});
test('invalid artifact result is rejected', async () => {
  const f = fixture(child => queueMicrotask(() => child.emit('message', {
    type: 'result', value: { outputPath: '/tmp/wrong.mp4', fileSize: 1000 },
  })));
  await assert.rejects(f.render(options), /invalid output artifact/);
});
test('progress and render phase remain visible to the native caller', async () => {
  const phases = []; const progress = [];
  const f = fixture(child => {
    child.emit('message', { type: 'phase', value: 'frame_capture' });
    child.emit('message', { type: 'progress', value: 50 }); succeed(child);
  });
  await f.render({ ...options, onPhase: value => phases.push(value), onProgress: value => progress.push(value) });
  assert.deepEqual(phases, ['frame_capture']); assert.deepEqual(progress, [50]);
});
