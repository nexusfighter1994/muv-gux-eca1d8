'use strict';
// vf-custom:tts-queue-full-v1 (2026-11-13, owner: "Ja")
// OpenSpeaker (ai33pro) answers a text-to-speech submission with HTTP 429 "You have too many tasks in
// queue (50/50)" while the account's queue is full (the account is also used outside VidForge). The
// native code never resubmits after a failed submission ("to avoid duplicate charges"), so the whole
// tts step failed after 3 s (ff3fd24a, 2026-11-13 18:43:45Z) and the video was retried hours later.
// A 429 is a definite rejection: no task was created and nothing was charged. Only in that case this
// wrapper waits (default 60 s, owner: "1 min") and submits the same piece again, for at most 60 min.
// Every other failure, including "acceptance unknown" (network, timeout, bad_json, bad_response),
// keeps the native behaviour: no resubmission.
const fs = require('node:fs');
const VERSION = 'tts-queue-full-v1';
const number = (value, fallback, min, max) => { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? n : fallback; };
const WAIT_MS = number(process.env.VF_TTS_QUEUE_FULL_WAIT_MS, 60000, 50, 600000);
const MAX_WAIT_MS = number(process.env.VF_TTS_QUEUE_FULL_MAX_MS, 3600000, 50, 4 * 3600000);

const rejectedSubmission = info => !!info && typeof info === 'object' && info.data?.provider === 'ai33pro'
  && info.data.phase === 'submission' && info.data.errorCode === 'http_429' && info.data.outcome === 'failed';
const notify = (fn, info) => { if (typeof fn === 'function') try { fn(info); } catch {} };
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaultExists = dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

// submit: the native function (one long-form piece: submit, poll, download). args: its single argument.
async function run(submit, args, { waitMs = WAIT_MS, maxWaitMs = MAX_WAIT_MS, sleep = defaultSleep, now = Date.now,
  jitter = Math.random, exists = defaultExists } = {}) {
  if (typeof submit !== 'function') throw new TypeError('submit function required');
  const forward = args?.onProviderStatus;
  const started = now();
  let waits = 0;
  for (;;) {
    let held = null;
    const watch = info => { if (held === null && rejectedSubmission(info)) held = info; else notify(forward, info); };
    try {
      return await submit({ ...args, onProviderStatus: watch });
    } catch (error) {
      const pause = Math.round(waitMs + jitter() * Math.min(10000, waitMs / 6));
      const again = held !== null && error?.code === 'http_429' && now() - started + pause <= maxWaitMs
        && (typeof args?.workDir !== 'string' || exists(args.workDir));
      if (!again) { if (held !== null) notify(forward, held); throw error; }
      waits += 1;
      if (waits === 1 || waits % 5 === 0) notify(forward, { level: 'warn',
        message: `OpenSpeaker queue is full (HTTP 429): nothing was submitted or charged; waiting ${Math.round(waitMs / 1000)}s, then submitting this piece again (wait ${waits})`,
        data: { provider: 'ai33pro', phase: 'submission', errorCode: 'http_429', outcome: 'waiting', waits,
          chunkNumber: held.data.chunkNumber, chunkCount: held.data.chunkCount } });
      await sleep(pause);
    }
  }
}

// Hot install: returns a replacement for the native function.
function create({ submit, ...options } = {}) {
  if (typeof submit !== 'function') throw new TypeError('submit function required');
  const wrapped = async function ttsPieceWithQueueWait(args) { return run(submit, args, options); };
  wrapped.__vfQueueFull = VERSION;
  wrapped.waitMs = options.waitMs ?? WAIT_MS;
  wrapped.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  return wrapped;
}

module.exports = { VERSION, WAIT_MS, MAX_WAIT_MS, run, create, rejectedSubmission };
