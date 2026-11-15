'use strict';
// vf-custom:artifact-probe-timeout-v1 (2026-11-13)
// Every checkpoint artifact (image or video) is read with ffprobe before the operation counts as done
// (bundle: sDt -> _Zi -> yZi). The native probe gives ffprobe 30 s. Under CPU overload (load 185, 99
// runnable processes on 16 cores) that was not enough for a 2-3 MB PNG: on 2026-11-13 16:04-16:25Z six
// finished AI stills were discarded ("the AI still fallback failed (Checkpoint artifact is missing or
// invalid ...)") and one chunk lost its transitions, although every file was intact. Same result and
// same failure behaviour as the native function, only the time limit is 180 s.
const VERSION = 'artifact-probe-timeout-v1';
const TIMEOUT_MS = 180000;

function create({ io, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof io !== 'function') throw new TypeError('io (ffprobe runner) is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30000 || timeoutMs > 900000) throw new RangeError('timeoutMs must be 30000-900000');
  const probe = async function probeArtifact(file) {
    try {
      const { stdout } = await io(['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { timeoutMs });
      const parsed = JSON.parse(stdout || '{}');
      const duration = Number(parsed?.format?.duration);
      const video = (parsed?.streams || []).find(stream => stream.codec_type === 'video');
      return { valid: !!video, durationSec: Number.isFinite(duration) ? duration : null, width: Number(video?.width) || null, height: Number(video?.height) || null };
    } catch {
      return { valid: false, durationSec: null, width: null, height: null };
    }
  };
  probe.__vfProbeTimeout = VERSION;
  probe.timeoutMs = timeoutMs;
  return probe;
}

module.exports = { create, VERSION, TIMEOUT_MS };
