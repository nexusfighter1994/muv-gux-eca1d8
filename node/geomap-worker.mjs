import { render } from './index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let settled = false;
process.on('disconnect', () => {
  if (!settled) process.kill(-process.pid, 'SIGKILL');
});

function send(message) {
  return new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

process.once('message', async message => {
  try {
    if (message.type !== 'render') throw new Error('Invalid GeoMap worker request');
    const options = message.options;
    const result = await render({ ...options,
      onPhase: value => { if (process.connected) process.send({ type: 'phase', value }, () => {}); },
      onProgress: value => { if (process.connected) process.send({ type: 'progress', value }, () => {}); },
    });
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,nb_frames:format=duration,size',
      '-of', 'json', options.targetPath], { timeout: 20000, maxBuffer: 16384 });
    const probe = JSON.parse(stdout);
    const video = probe.streams?.[0];
    const [num, den] = String(video?.r_frame_rate || '').split('/').map(Number);
    const fps = Number(options.params.fps) || 30;
    const frames = Number(options.params.frames);
    if (video?.codec_name !== 'h264' || video.width !== (Number(options.params.width) || 1920)
        || video.height !== (Number(options.params.height) || 1080)
        || Math.abs(num / den - fps) > 0.001 || !(Number(probe.format?.size) > 0)
        || Math.abs(Number(probe.format.duration) - frames / fps) > 2 / fps) {
      throw new Error('GeoMap worker output failed codec, dimensions, FPS or duration validation');
    }
    await send({ type: 'result', value: { outputPath: result.outputPath, fileSize: result.fileSize, metrics: result.metrics } });
    settled = true;
    process.disconnect();
  } catch (error) {
    if (process.connected) await send({ type: 'error', message: error.message,
      code: error.code || null, phase: error.phase || null }).catch(() => undefined);
    process.exitCode = 1;
    settled = true;
    if (process.connected) process.disconnect();
  }
});
