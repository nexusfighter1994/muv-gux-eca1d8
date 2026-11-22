// vf-custom:motion-busy-retry-v1 (2026-11-22). Owner: "Animationen die Home nicht kann ... oder rausfinden wie
// Home es schaffen kann!"
//
// The Home PC renders an animation on one of its 12 CPU worker slots, the same slots its ffmpeg jobs use. When all
// 12 are taken at the moment of the request, Home answers 503 {"error":"unavailable"} within ~80 ms. The hooks treated
// that like a failed render: the animation fell back to the server and landed in the Home Motion recovery lane, which
// runs 2 at a time. Measured 22.11.: 6 of 22 Home render requests were such instant 503s, the Home CPU lane was full
// in 7 of 40 samples, 14-27 recoveries waited and blocked every Home Motion slot (homeActive 0-1 of 9) while 32-79
// animations queued for up to 71 min. The animations themselves are short (avg 6.2 s; 0.1 % above 15 s).
//
// A fast 503 now means "no free slot right now": wait a moment and ask again with a new job id (Home refuses a reused
// id for 610 s). Slow failures (a render that really failed or timed out) and everything else are unchanged.
// Hot knob /data/runtime/vf-motion-busy-retry.json {"enabled", "waitMs", "maxWaitMs", "fastMs", "minRenderMs"}.
import fs from 'node:fs';
import crypto from 'node:crypto';

export const DEFAULTS = Object.freeze({ enabled: true, waitMs: 2500, maxWaitMs: 60000, fastMs: 3000, minRenderMs: 60000 });
export const KNOB = '/data/runtime/vf-motion-busy-retry.json';
const LIMITS = { waitMs: [250, 30000], maxWaitMs: [0, 300000], fastMs: [100, 30000], minRenderMs: [1000, 600000] };

export function parseKnob(text) {
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(text);
    if (raw && raw.enabled === false) out.enabled = false;
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const v = Number(raw && raw[key]);
      if (Number.isFinite(v) && v >= min && v <= max) out[key] = Math.floor(v);
    }
  } catch { /* no file or broken file = defaults */ }
  return out;
}

let cached = { at: -Infinity, cfg: { ...DEFAULTS } };
export function readKnob(now = Date.now(), read = () => fs.readFileSync(KNOB, 'utf8')) {
  if (now - cached.at >= 5000) {
    let text = '';
    try { text = read(); } catch { text = ''; }
    cached = { at: now, cfg: parseKnob(text) };
  }
  return cached.cfg;
}

// One counter object for both hook modules (and for a re-imported copy of them).
export const stats = globalThis.__vfMotionBusyRetry ?? (globalThis.__vfMotionBusyRetry =
  { version: 1, requests: 0, busy: 0, retries: 0, recovered: 0, gaveUp: 0, waitedMs: 0, lastBusyAt: null, lastRecoveredAt: null });

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// send(id) -> { response, payload }. Returns the last answer with the id and payload that produced it.
export async function sendWithBusyRetry({ send, firstId, homeDeadline, signal, settings = () => readKnob(), now = () => Date.now(),
  sleep = wait, newId = () => crypto.randomBytes(16).toString('hex') }) {
  let id = firstId, waited = 0, tries = 0;
  stats.requests += 1;
  for (;;) {
    const started = now();
    const { response, payload } = await send(id);
    tries += 1;
    let cfg;
    try { cfg = settings() || DEFAULTS; } catch { cfg = DEFAULTS; }
    const busy = response.status === 503 && now() - started <= cfg.fastMs;
    if (!busy) {
      if (tries > 1 && response.ok) { stats.recovered += 1; stats.lastRecoveredAt = new Date(now()).toISOString(); }
      return { response, payload, id, tries };
    }
    stats.busy += 1; stats.lastBusyAt = new Date(now()).toISOString();
    const room = Number.isFinite(homeDeadline) ? homeDeadline - now() - cfg.waitMs >= cfg.minRenderMs : true;
    if (!cfg.enabled || waited + cfg.waitMs > cfg.maxWaitMs || !room) {
      if (tries > 1) stats.gaveUp += 1;
      return { response, payload, id, tries };
    }
    try { await response.arrayBuffer?.(); } catch { /* body already gone */ }
    await sleep(cfg.waitMs, signal);
    waited += cfg.waitMs; stats.retries += 1; stats.waitedMs += cfg.waitMs;
    id = newId();
  }
}
