// SigLIP ranking on the RunPod burst pod: the same rank service as the Home PC (pod-worker
// proxies /siglip/* to it), reached through the same Home rank sender with the pod's endpoint
// and token. Its free slots add to the Home SigLIP capacity while the pod is ready.
import { createHomeSiglipRankSender } from '../home-siglip-transport.mjs';

export const MODEL_ID = 'google/siglip2-base-patch16-384', MODEL_REVISION = 'f775b65a79762255128c981547af89addcfe0f88';

export function createPodSiglip({ getBurst = () => globalThis.__vfBurst, getScope, budget, readTransfer, fflow, fetcher = fetch,
  now = Date.now, schedule = fn => setInterval(fn, 3000), createRankSender = createHomeSiglipRankSender } = {}) {
  let health = null, at = 0, busy = false, backendId = null;
  const stats = { ranked: 0, unavailable: 0, failed: 0 };
  const backend = () => { try { return getBurst?.()?.backend?.() ?? null; } catch { return null; } };
  const probe = async () => {
    if (busy) return;
    busy = true;
    try {
      const b = backend();
      if (!b) { health = null; return; }
      const response = await fetcher(b.endpoint + '/siglip/health', { headers: { Authorization: 'Bearer ' + b.token }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error('pod SigLIP health HTTP ' + response.status);
      const value = await response.json();
      if (value.ready !== true || value.device !== 'cuda' || value.model_id !== MODEL_ID || value.model_revision !== MODEL_REVISION
        || value.multi_query !== true) throw Error('pod SigLIP model mismatch');
      health = value; at = now(); backendId = b.id;
    } catch { health = null; } finally { busy = false; }
  };
  const timer = schedule(() => void probe());
  timer?.unref?.();
  void probe();
  const capacity = () => {
    const b = backend();
    if (!b || !health || b.id !== backendId || now() - at >= 10000) return 0;
    return Math.max(0, Math.min(25, Number(health.configured_concurrency) || 0) - (Number(health.active_tasks) || 0));
  };
  const rank = async body => {
    const b = backend();
    if (!b || capacity() <= 0) { stats.unavailable++; return null; }
    const sender = createRankSender({ getScope, budget, readTransfer, fflow, fetcher, url: b.endpoint + '/siglip', readToken: () => b.token,
      readConfig: () => ({ enabled: true, siglipEnabled: true, siglipConcurrency: Math.max(1, Number(health?.configured_concurrency) || 1) }) });
    try {
      const result = await sender(body);
      if (result) stats.ranked++; else stats.unavailable++;
      return result;
    } catch (error) { stats.failed++; throw error; }
  };
  return { capacity, rank, stats, snapshot: () => ({ health, checkedAt: at, backendId }), timer, probe };
}

// Home first while it has room, otherwise the pod; the other one when the first cannot take it.
export function combineRank({ rankHome, homeCapacity, pod }) {
  return async body => {
    const homeFirst = Number(homeCapacity()) > 0;
    const first = homeFirst ? rankHome : pod.rank, second = homeFirst ? pod.rank : rankHome;
    const result = await first(body).catch(error => { if (!homeFirst) return null; throw error; });
    return result ?? second(body);
  };
}
