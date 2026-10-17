'use strict';
// A transient Home-fallback admission failure inside FFlow ("Native Home fallback
// POST retry exhausted" etc.) must never fail a chunk/pipeline. While the caller is
// still polling (same native lease, same Home scope), the identical FFlow request is
// submitted again; the caller keeps polling its original job id, transparently
// aliased to the newest attempt. Every other failure is returned unchanged.

const TRANSIENT = /Native Home fallback (?:(?:POST|GET|DELETE) retry exhausted|admission (?:unavailable|timed out|failed)|permit (?:unavailable|is not active)|renewal (?:lost|stopped))/;
const JOB_PATH = /^\/v1\/jobs\/([^/?#]+)/;

function failureText(data) {
  try { return JSON.stringify([data?.error ?? null, data?.message ?? null, data?.result?.error ?? null]); } catch { return ''; }
}

function createResubmitter(original, { maxResubmits = 3, delayMs = 5000, sleep = ms => new Promise(r => setTimeout(r, ms)),
  maxTracked = 4000, log = () => {} } = {}) {
  if (typeof original !== 'function') throw new TypeError('original must be a function');
  if (original.__vfResubmit) return original;
  const submissions = new Map(); // job id -> {path, options}
  const alias = new Map();       // original id -> newest id
  const attempts = new Map();    // original id -> resubmits used
  const recovered = new Set();
  const stats = { tracked: 0, resubmits: 0, recovered: 0, exhausted: 0, last: null };
  const remember = (id, entry) => {
    submissions.set(id, entry);
    stats.tracked = submissions.size;
    while (submissions.size > maxTracked) submissions.delete(submissions.keys().next().value);
    while (alias.size > maxTracked) { const k = alias.keys().next().value; alias.delete(k); attempts.delete(k); }
  };

  async function request(path, options = {}) {
    const method = String(options?.method || 'GET').toUpperCase();
    const match = typeof path === 'string' ? JOB_PATH.exec(path) : null;
    const root = match ? decodeURIComponent(match[1]) : null;
    const current = root && alias.get(root);
    const target = current ? path.replace(match[1], encodeURIComponent(current)) : path;
    const response = await Reflect.apply(original, this, [target, options]);
    if (!match && method === 'POST' && options?.body && options.body.wait_for_results === false) {
      const id = response?.data?.job_id || response?.job_id;
      if (typeof id === 'string' && id) remember(id, { path, options });
      return response;
    }
    if (!root || method !== 'GET' || !response?.data) return response;
    const data = response.data;
    if (data.status === 'failed' && TRANSIENT.test(failureText(data))) {
      const used = attempts.get(root) || 0, submission = submissions.get(current || root);
      if (submission && used < maxResubmits) {
        attempts.set(root, used + 1);
        await sleep(delayMs * (used + 1));
        const again = await Reflect.apply(original, this, [submission.path, submission.options]);
        const next = again?.data?.job_id || again?.job_id;
        if (typeof next === 'string' && next) {
          alias.set(root, next);
          remember(next, submission);
          stats.resubmits++;
          stats.last = { root, next, attempt: used + 1, at: new Date().toISOString() };
          log({ event: 'resubmitted', root, next, attempt: used + 1 });
          // The caller keeps polling: report the fresh attempt as queued under its original id.
          return { ...response, data: { ...data, status: 'queued', error: null, job_id: root, vf_resubmitted: next } };
        }
      }
      if (submission) stats.exhausted++;
    }
    if (current) {
      if (data.status === 'completed' && !recovered.has(root)) { recovered.add(root); stats.recovered++; if (recovered.size > maxTracked) recovered.clear(); }
      return { ...response, data: { ...data, job_id: root } };
    }
    return response;
  }
  request.__vfResubmit = true;
  request.stats = stats;
  request.original = original;
  return request;
}

module.exports = { createResubmitter, TRANSIENT };
