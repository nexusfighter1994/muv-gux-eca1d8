'use strict';
// vf-custom 2026-11-16: native RunPod GPU-FFmpeg pool made usable + queue-driven on/off.
// Owner 16.11.: "Runpod soll sich deaktivieren sobald in ffmpeg unter 800 dinge ist und sich wieder
// aktivieren sobald 2000 dinge gequed sind ... Hot und baus dann so das es bei nem neustart fix ist".
//
// Fixes on the stock pool (all found in the 16.11. test, see Brain vidforge-ffmpeg-backlog-20261105):
//  1. RunPod REST v1 (rest.runpod.io/v1) was retired on 2026-11-16 -> pod create/get/delete are
//     translated to REST v2 (https://api.runpod.io/v2/pods), responses mapped back to the v1 shape.
//  2. The pod's NVENC self-test encodes a 64x64 frame, below the NVENC minimum on current GPUs ->
//     health reports ready=false forever. Accept the pod when it reports gpu profile + h264_nvenc + name.
//  3. Image pinned to the tag matching our base; boot deadline 8 -> 25 min (8.6 GB pull).
//  4. GPU offers filtered to >= minVramGb (stock picks the cheapest >= 8 GB = 2 slots); more offers tried.
//  5. Pod env FFLOW_GPU_SLOT_CPU_CAP=false (slot cap = vCPU/2 otherwise), min vCPU kept.
//  6. acquire(): stock waits for a pod slot without timeout. Now: pod full -> wait only while fewer than
//     podQueueMax jobs wait, else run locally; no ready pod -> run locally at once and trigger one
//     spin-up attempt at most every 3 min.
//  7. Deterministic ffmpeg errors (bad source clip) no longer count as pod failures (2 in a row
//     quarantined and killed the whole pod).
//  8. Controller: gpuFfmpegEnabled off when the ffmpeg lane queue < offBelow, on when >= onAbove.
//  9. 2026-11-21 owner: "wenn motion graphics que auf ueber 900 ist soll sich runpod dazuschalten bis der que auf
//     300 gesunken ist. Aber ruhig eine staerkere gpu schon mit grenze 80 cent aber die beste die er kriegen kann
//     soll gewaehlt werden. Der filter mit beste die available ist soll auch fuer die 2000er ffmpeg grenze sein."
//     -> render (motion graphics) trigger on at >= 900, off at <= 300 (with the ffmpeg rule unchanged), and the
//     offer list is ordered STRONGEST first within the native price cap (stock: cheapest first). Strength = the
//     highest in-stock price of that GPU type (RunPod prices track performance), then VRAM; the cheaper offer of the
//     same type is tried first. Blackwell types are left out: two RTX 5080 pods failed at once on 20.11. with
//     "Encoder error - FFmpeg could not encode one or more frames" (pod image ffmpeg/NVENC too old for them).
// 10. 2026-11-21: pod concurrency follows its CPU. The stock gives a non-GeForce card floor((VRAM-4)/2) slots
//     (48 GB L40 -> 22). Animations render on the pod's CPU (21.11.: 24 vCPU at 97 %, GPU 0 %), so 22 at once took
//     ~12 min each and ran into the stock 15-min pod operation timeout -> "render failure" -> pod quarantined (the
//     20.11. losses). Each pod's slots are capped at floor(vCPU / cpuPerPodSlot) (vCPU from the RunPod v2 pod
//     record), or podMaxConcurrency while the vCPU count is unknown.
// Hot knob (no restart): /data/runtime/vf-runpod-pool.json, e.g. {"controller":{"enabled":false}}.

const fs = require('node:fs');

const FILE = process.env.VF_RUNPOD_POOL_FILE || '/data/runtime/vf-runpod-pool.json';
const V1 = 'https://rest.runpod.io/v1/pods';
const V2 = 'https://api.runpod.io/v2/pods';
const DEFAULTS = Object.freeze({
  enabled: true,
  imageTag: 'afflicted9436/x2tqkmidyo:2026.10.21',
  bootTimeoutMin: 30,  // Secure Cloud needs ~25 min (image pull); below that only Community hosts would ever boot
  // 21.11. 11:11Z: two animation renders on a 12-slot L40 ran past the stock 15-min pod op timeout; the app then
  // switched render off for that pod for good. Owner rule: generous timeouts instead of less parallelism.
  opTimeoutMin: 30,
  // 21.11. 12:51Z: one network blip (render agent poll timeout on all pods at once) made the app switch render off
  // on every pod for good ("render failed twice"); paid pods then sat idle. renderRetryMin: re-probe a pod whose
  // render service is off after this many minutes (0 = never).
  renderRetryMin: 3,
  // 21.11. 12:55Z owner: "40min booten waere doch geldverschwendung ... das muss doch schneller gehen". Secure Cloud
  // pods needed 21-25 min to boot (image pull), Community pods 4-6 min. preferCloud ranks that cloud first.
  preferCloud: 'COMMUNITY',
  offerCount: 8,
  minVramGb: 16,
  // 'strongest' (owner 21.11.) or 'cheapest' (stock order).
  // 21.11. 13:15Z: 'value' = most work per dollar (learned vCPU and boot time per GPU type + cloud), see offerValue.
  gpuPick: 'value',
  // Pod count by budget (planPods): more pods while work waits and spend stays <= maxHourlySpend ($/h; owner 21.11.
  // approved 3 pods at <= $0.80), replace a pod worth < replaceRatio of the best offer, drain spare pods.
  podScaling: true,
  // live vCPU per offer from RunPod (enrichOffers); tiers above minVcpuPerGpu that are probed and may be requested
  liveVcpu: true,
  vcpuTiers: [24, 32],
  maxHourlySpend: 2.0,
  maxPods: 6,
  scaleUpQueued: 8,
  renderMinutes: 6,
  replaceRatio: 0.6,
  scaleDownMin: 5,
  planHorizonMin: 120,
  // Tested against `${id} ${displayName}`; empty string = nothing excluded.
  excludeGpus: 'RTX 50[0-9]0|RTX PRO|Blackwell|\\bB[12]00\\b',
  // Pod slots = floor(vCPU / cpuPerPodSlot); podMaxConcurrency while the vCPU count is unknown. 0 = stock slots.
  cpuPerPodSlot: 2,
  podMaxConcurrency: 12,
  minVcpuPerGpu: 4,
  podEnv: { FFLOW_GPU_SLOT_CPU_CAP: 'false' },
  allowedCudaVersions: [],
  restV2: true,
  forceHealthReady: true,
  podQueueMax: 20,
  rescueFair: true,
  spinupRetrySec: 180,
  deterministicErrors: 'FFMPEG_ERROR|Encoder error|could not encode|Invalid data found|Conversion failed',
  // 21.11. 12:51Z + 14:16Z: the API stalled (kernel OOM), every render poll timed out at once, the app counted two
  // failures per pod and switched render off on ALL pods; 38 running pod renders were thrown away and re-run
  // locally, which pushed the server deeper into the memory hole. Such errors do not count against a pod unless
  // the pod mostly fails, and a timed-out status poll is repeated (renderPollRetries, fresh 50-s timeout each).
  transientErrors: 'network error|aborted due to timeout|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up',
  renderPollRetries: 4,
  controller: {
    enabled: true,
    offBelow: 800,
    onAbove: 2000,
    checkSec: 60,
    minOnMinutes: 0,
    // 17.11. owner: "Bei animationen irgendeine idee die auch funktioniert? Dann setz sie um" -> the pod also
    // takes the animation backlog: on when render queue >= renderOnAbove, off only when ffmpeg < offBelow AND
    // render < renderOffBelow. 'combined' marks this controller (v2) active even with enabled:false, which only
    // silences the first hot-loaded controller (v1) in a running process.
    // 17.11. ~13:20 owner: "Renderschwelle fuer animationen raus" -> render trigger off (0); the pod took only 33 of
    // 1687 animations (queued render waiters stay local) and the render trigger kept it on for hours.
    // 21.11. owner: back on, on at >= 900 waiting motion graphics renders, off once <= 300 (and ffmpeg < offBelow).
    renderOnAbove: 900,
    renderOffBelow: 300,
    combined: true,
    // Cost guard: pool off and a pod idle this long -> terminate it ourselves (stock idle drain is the
    // first line; this catches a drain that never fires).
    guardIdleMinutes: 7,
    // No 'compositions' (17.11.): the pod's NVENC writes H.264 Main profile while local chunks are High; mixed
    // chunks fail the final copy-join signature check and every chunk gets re-encoded (~1 min each).
    // 17.11. ~13:30 owner: "Nur noch fuer ffmpeg zeug stau" -> trigger only on the ffmpeg queue.
    // 17.11. ~14:50 owner: "wenn der pod laeuft kann er ruhig animationsarbeit auch helfen aber getriggerd wird
    // er halt nur bei ffmpeg stau" -> while on, the pod takes b-roll ffmpeg work AND animations.
    workloads: ['brollAnalysis', 'animations'],
  },
});

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v) : v;
  }
  return out;
}

function createConfigReader(file = FILE, fsImpl = fs) {
  let cache = { mtime: -1, cfg: merge(DEFAULTS, {}) };
  return function read() {
    try {
      const st = fsImpl.statSync(file);
      if (st.mtimeMs !== cache.mtime) cache = { mtime: st.mtimeMs, cfg: merge(DEFAULTS, JSON.parse(fsImpl.readFileSync(file, 'utf8'))) };
    } catch (e) {
      if (e && e.code === 'ENOENT') cache = { mtime: -2, cfg: merge(DEFAULTS, {}) };
    }
    return cache.cfg;
  };
}

function notFound(url) {
  const e = new Error(`GET ${url} -> HTTP 404 (v2 TERMINATED)`);
  e.status = 404;
  e.detail = { status: 404, body: '' };
  return e;
}

// v1 create body (stock) -> v2 create body
function v2CreateBody(j, cfg, tier = tierFor((j.gpuTypeIds || [])[0], j.cloudType)) {
  const minVcpu = Math.max(Number(cfg.minVcpuPerGpu) || 4, Number(j.minVCPUPerGPU) || 0, Number(tier) || 0);
  const gpu = { id: (j.gpuTypeIds || [])[0], count: 1, minRamPerGpu: j.minRAMPerGPU, minVcpuCountPerGpu: minVcpu };
  if (Array.isArray(cfg.allowedCudaVersions) && cfg.allowedCudaVersions.length) gpu.allowedCudaVersions = cfg.allowedCudaVersions;
  const body = {
    name: j.name,
    image: j.imageName,
    cloud: j.cloudType || 'SECURE',
    gpu,
    disk: j.containerDiskInGb,
    ports: j.ports,
    env: { ...(j.env || {}), ...(cfg.podEnv || {}) },
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

// vCPU count per pod id, shared across hot reloads of this module.
const POD_CPU = globalThis.__vfRunpodPodCpu || (globalThis.__vfRunpodPodCpu = new Map());

function v1Shape(r) {
  if (!r || !r.id) return r;
  const gpuId = r.gpu && r.gpu.id;
  const vcpu = Number((r.gpu && r.gpu.vcpuCount) ?? r.vcpuCount);
  if (Number.isFinite(vcpu) && vcpu > 0) POD_CPU.set(r.id, vcpu);
  return { ...r, desiredStatus: r.status, costPerHr: r.cost, gpuTypeId: gpuId, imageName: r.image, machine: { gpuTypeId: gpuId },
    ...(Number.isFinite(vcpu) && vcpu > 0 ? { vcpuCount: vcpu } : {}) };
}

// Cap each pod's concurrency (stock XI() takes min(VRAM slots, safeConcurrency)). Returns the number of pods changed.
function capPodSlots(pods, cfg, cpu = POD_CPU) {
  const per = Number(cfg.cpuPerPodSlot);
  if (!(per > 0)) return 0;
  let changed = 0;
  for (const p of pods || []) {
    if (!p || !p.id) continue;
    // Only animations are CPU-bound. With the render service off (the app disables it after render failures) the
    // pod does NVENC trims, where the stock slots are fine; the app also resets safeConcurrency after failures.
    if (p.capabilities && p.capabilities.render === false) continue;
    const vcpu = Number(cpu.get(p.id));
    const fallback = Math.floor(Number(cfg.podMaxConcurrency)) || 0;
    const cap = Number.isFinite(vcpu) && vcpu > 0 ? Math.max(1, Math.floor(vcpu / per)) : fallback;
    if (!(cap > 0)) continue;
    const cur = Math.floor(Number(p.safeConcurrency));
    if (!(Number.isFinite(cur) && cur > 0 && cur <= cap)) { p.safeConcurrency = cap; changed++; }
  }
  return changed;
}

// Re-probe pods whose render service the app switched off, once it has been off for renderRetryMin minutes.
function reenableRender(pods, cfg, reprobe, seen, now = Date.now()) {
  const min = Number(cfg.renderRetryMin);
  if (!(min > 0) || typeof reprobe !== 'function') return 0;
  let n = 0;
  const live = new Set();
  for (const p of pods || []) {
    if (!p || !p.id || p.state !== 'ready') continue;
    live.add(p.id);
    const off = p.disabledServices && typeof p.disabledServices.has === 'function' && p.disabledServices.has('render');
    if (!off) { seen.delete(p.id); continue; }
    if (!seen.has(p.id)) { seen.set(p.id, now); continue; }
    if (now - seen.get(p.id) < min * 60000) continue;
    p.disabledServices.delete('render');
    seen.delete(p.id);
    n++;
    Promise.resolve().then(() => reprobe(p)).catch(() => {});
  }
  for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
  return n;
}

// Pod count by budget instead of a fixed number (21.11.). Decides from one snapshot:
// - scale up: work waits (pool waiters + rescue waiting >= scaleUpQueued), nothing boots, fewer than maxPods,
//   spend + the best offer's price <= maxHourlySpend.
// - replace: the worst ready pod gives less than replaceRatio of the best offer's work per dollar -> start the better
//   one (spend without the worst pod must stay in budget); once a newer pod is ready, the worst one drains.
// - scale down: no work waits and the free slots cover the worst pod for scaleDownMin -> it drains.
function planPods(snap, cfg, state) {
  const { pods = [], waiting = 0, offers = [], now = Date.now(), cpu = POD_CPU, learn = LEARN } = snap;
  const live = pods.filter(p => p && (p.state === 'ready' || p.state === 'booting'));
  const usable = live.filter(p => !String(p.image || '').includes('#vf-drain'));
  const spend = live.reduce((sum, p) => sum + (Number(p.costPerHr) || 0), 0);
  const booting = Boolean(snap.spinning) || live.some(p => p.state === 'booting');
  const ready = usable.filter(p => p.state === 'ready' && !(p.capabilities && p.capabilities.render === false));
  // best = the best-value offer that still fits the budget; top = the best offer at all (for replacing).
  const maxSpendEarly = Number(cfg.maxHourlySpend) || 0;
  const top = offers[0] || null;
  const best = offers.find(x => spend + Number(x.price) <= maxSpendEarly + 1e-9) || null;
  const bestValue = best ? offerValue(best, cfg, learn) : 0;
  const topValue = top ? offerValue(top, cfg, learn) : 0;
  const maxSpend = Number(cfg.maxHourlySpend) || 0, maxPods = Math.floor(Number(cfg.maxPods)) || 1;
  let worst = null;
  for (const p of ready) if (!worst || podValue(p, cfg, cpu) < podValue(worst, cfg, cpu)) worst = p;
  const free = ready.reduce((sum, p) => sum + Math.max(0, podSlots(p, cfg, cpu) - (Number(p.inflight) || 0)), 0);
  const out = { spawn: false, drain: null, cancel: null, reason: null, spend: Math.round(spend * 100) / 100, waiting, free,
    best: best ? `${best.displayName || best.id} ${best.cloudType} $${best.price} (${bestValue.toFixed(1)})` : null };
  if (state.replace) {
    const target = live.find(p => p.id === state.replace.id);
    const newer = usable.find(p => p.state === 'ready' && p.id !== state.replace.id && Date.parse(p.createdAt) >= state.replace.at);
    if (!target) state.replace = null;
    else if (newer) { out.drain = target.id; out.reason = `replaced by ${newer.id}`; state.replace = null; return out; }
    else if (now - state.replace.at > 45 * 60000) state.replace = null;
  }
  // Hard budget (owner 21.11. 13:45Z: "Maximalpreis von so viel pods auf 2 EUR pro stunde Maximum"): pods that are
  // not draining yet cost more than maxHourlySpend -> the worst-value pod drains. Nothing is ever started that
  // would lift the bill (draining pods included, they are billed until they end) above the budget.
  // 13:58Z lesson: a pod that is still booting goes first (newest first, nothing is lost); a working pod only
  // drains when nothing boots. Before, a working L4 was drained for an identical L4 that had 22 min of boot ahead.
  const committed = usable.reduce((sum, p) => sum + (Number(p.costPerHr) || 0), 0);
  if (maxSpend > 0 && committed > maxSpend + 1e-9) {
    const boots = usable.filter(p => p.state === 'booting').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (boots.length) {
      out.cancel = boots[0].id;
      out.reason = `over budget: $${committed.toFixed(2)}/h > $${maxSpend}/h, booting pod ${boots[0].id} is stopped`;
      return out;
    }
    if (worst) {
      out.drain = worst.id;
      out.reason = `over budget: $${committed.toFixed(2)}/h > $${maxSpend}/h, least work per dollar goes`;
      return out;
    }
  }
  const fits = without => Boolean(best) && spend - without + Number(best.price) <= maxSpend + 1e-9;
  // A new pod only pays off if work is left when it has booted (18:16Z: a second pod was started for 53 waiting
  // renders; the first pod had them done before the boot ended). The pods that run now finish about
  // readySlots * boot / renderMinutes renders during the boot of the best offer; that much must wait on top.
  const readySlots = ready.reduce((sum, p) => sum + podSlots(p, cfg, cpu), 0);
  const lb = (best && learn && learn.get(best.id, best.cloudType)) || {};
  const bootMin = best ? (Number(lb.bootMin) > 0 ? Number(lb.bootMin) : (BOOT_DEFAULT_MIN[String(best.cloudType || 'SECURE').toUpperCase()] ?? 20)) : 0;
  const needWaiting = (Number(cfg.scaleUpQueued) || 8) + Math.ceil(readySlots * bootMin / (Number(cfg.renderMinutes) || 6));
  out.needWaiting = needWaiting;
  if (!booting && best && waiting >= needWaiting && live.length < maxPods && fits(0)) {
    out.spawn = true;
    out.reason = `scale up: ${waiting} waiting, spend $${out.spend}/h + ${out.best}`;
    return out;
  }
  const sinceReplace = now - (Number(state.lastReplaceAt) || 0);
  const fitsTop = without => Boolean(top) && spend - without + Number(top.price) <= maxSpend + 1e-9;
  if (!booting && !state.replace && top && worst && waiting > 0 && sinceReplace > 30 * 60000
    && podValue(worst, cfg, cpu) < (Number(cfg.replaceRatio) || 0) * topValue) {
    const what = `${worst.id} (${worst.gpuType}, ${podValue(worst, cfg, cpu).toFixed(1)} slots/$) by ${top.displayName || top.id} ${top.cloudType} $${top.price} (${topValue.toFixed(1)})`;
    if (fitsTop(0) && live.length < maxPods) {
      // room in the budget: start the better pod first, the worst one drains once it is ready
      out.spawn = true;
      state.replace = { id: worst.id, at: now };
      state.lastReplaceAt = now;
      out.reason = `replace ${what}`;
      return out;
    }
    if (fitsTop(Number(worst.costPerHr) || 0)) {
      // no room for both: the worst pod drains first, the next scale-up takes the better offer
      out.drain = worst.id;
      state.lastReplaceAt = now;
      out.reason = `replace (drain first, budget) ${what}`;
      return out;
    }
  }
  if (waiting === 0 && !booting && worst && ready.length > 1 && free >= podSlots(worst, cfg, cpu)) {
    if (state.spareSince == null) state.spareSince = now;
    if (now - state.spareSince >= (Number(cfg.scaleDownMin) || 5) * 60000) {
      out.drain = worst.id;
      out.reason = `scale down: ${free} free slots, no work waiting`;
      state.spareSince = null;
    }
  } else state.spareSince = null;
  return out;
}

function wrapKt(orig, read, stats) {
  const wrapped = function vfRunpodKt(url, opts = {}) {
    const cfg = read();
    if (cfg.enabled && cfg.restV2 && typeof url === 'string' && url.startsWith(V1)) {
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      const id = url.slice(V1.length).replace(/^\//, '');
      if (method === 'POST' && !id && opts.json) {
        stats.v2create++;
        return Promise.resolve(orig.call(this, V2, { ...opts, json: v2CreateBody(opts.json, cfg) })).then(v1Shape);
      }
      if (method === 'GET' && id && !id.includes('/')) {
        stats.v2get++;
        return Promise.resolve(orig.call(this, `${V2}/${id}`, { ...opts })).then(r => {
          if (r && String(r.status).toUpperCase() === 'TERMINATED') throw notFound(`${V2}/${id}`);
          return v1Shape(r);
        });
      }
      if (method === 'DELETE' && id && !id.includes('/')) {
        stats.v2delete++;
        return orig.call(this, `${V2}/${id}`, { ...opts });
      }
    }
    const res = orig.call(this, url, opts);
    if (cfg.enabled && cfg.forceHealthReady && typeof url === 'string' && /\.proxy\.runpod\.net\/v1\/health$/.test(url)) {
      return Promise.resolve(res).then(r => {
        const s = (r && r.data) || r;
        const g = s && s.ffmpeg && s.ffmpeg.gpu;
        if (g && g.profile === 'gpu' && g.h264_nvenc === true && g.gpu_name && g.ready === false) {
          g.ready = true;
          g.vfForcedReady = true;
          stats.forcedReady++;
        }
        return r;
      });
    }
    return res;
  };
  wrapped.__vfOrig = orig;
  return wrapped;
}

function excludeRegex(cfg) {
  const src = typeof cfg.excludeGpus === 'string' ? cfg.excludeGpus : '';
  if (!src) return null;
  try { return new RegExp(src, 'i'); } catch { return null; }
}

// Coarse render/encode strength of known RunPod GPU types (0-100). Price alone misleads: on 21.11. a Secure L4 cost
// 0.69 $/h like an L40 or A6000 and more than an A40. Unknown types fall back to price x 100.
const GPU_STRENGTH = [
  [/L40S/i, 100], [/RTX 6000 Ada/i, 98], [/RTX 4090/i, 96], [/\bL40\b/i, 95], [/RTX 5000 Ada/i, 85], [/RTX 4080/i, 80],
  [/RTX A6000|\bA6000\b/i, 75], [/\bA40\b/i, 72], [/RTX 3090 Ti/i, 68], [/RTX 3090/i, 65], [/RTX 4500 Ada/i, 62],
  [/RTX A5000|\bA5000\b/i, 60], [/RTX 4070/i, 58], [/RTX 4000 Ada/i, 55], [/RTX A4500|\bA4500\b/i, 55], [/RTX 3080/i, 55],
  [/\bA10G?\b/i, 45], [/\bL4\b/i, 45], [/RTX A4000|\bA4000\b/i, 45], [/RTX 2000 Ada/i, 35], [/\bA16\b/i, 15],
];
function gpuStrength(x, maxPrice) {
  const name = `${x.displayName || ''} ${x.id || ''}`;
  for (const [re, score] of GPU_STRENGTH) if (re.test(name)) return score;
  return Math.round((Number(maxPrice) || 0) * 100);
}

// ---- Live vCPU per offer (21.11. 13:20Z, owner: "kannst du vcpu zahl irgendwie rausfinden damit das ins ranking
// miteinfliesst?") ----
// RunPod's lowestPrice(input: { gpuCount: 1, secureCloud, minVcpuCount }) tells per GPU type and cloud whether a host
// with at least that many vCPU is free (stockStatus), how many vCPU the cheapest such host has (minVcpu) and its price.
// Offers without a host >= minVcpuPerGpu are dropped (the create would fail), and per offer the vCPU tier with the
// most slots per dollar is chosen and requested at create time (minVcpuCountPerGpu).
const VCPU = globalThis.__vfRunpodVcpu || (globalThis.__vfRunpodVcpu = { at: 0, map: new Map(), tiers: new Map(), error: null });
function vcpuTiers(cfg) {
  const min = Number(cfg.minVcpuPerGpu) || 4;
  const extra = (Array.isArray(cfg.vcpuTiers) ? cfg.vcpuTiers : [24, 32]).map(Number).filter(v => Number.isFinite(v) && v > min);
  return [...new Set([min, ...extra])].sort((a, b) => a - b);
}
function vcpuQuery(tiers) {
  const parts = [];
  for (const t of tiers) for (const [k, secure] of [['s', true], ['c', false]]) {
    parts.push(`${k}${t}: lowestPrice(input: { gpuCount: 1, secureCloud: ${secure}, minVcpuCount: ${t} }) { stockStatus minVcpu uninterruptablePrice }`);
  }
  return `query { gpuTypes { id ${parts.join(' ')} } }`;
}
function parseVcpu(data, tiers) {
  const map = new Map();
  for (const g of (data && data.gpuTypes) || []) {
    if (!g || !g.id) continue;
    for (const [k, cloud] of [['s', 'SECURE'], ['c', 'COMMUNITY']]) {
      const rows = [];
      for (const t of tiers) {
        const lp = g[`${k}${t}`];
        const v = Number(lp && lp.minVcpu);
        if (lp && lp.stockStatus && v > 0) rows.push({ tier: t, vcpu: v, price: Number(lp.uninterruptablePrice), stock: lp.stockStatus });
      }
      map.set(`${g.id}|${cloud}`, rows);
    }
  }
  return map;
}
async function refreshVcpu(gql, cfg, now = Date.now()) {
  if (typeof gql !== 'function') return VCPU.map;
  if (now - VCPU.at < 4 * 60000 && VCPU.map.size) return VCPU.map;
  try {
    const tiers = vcpuTiers(cfg);
    const r = await gql(vcpuQuery(tiers));
    const map = parseVcpu(r && r.data, tiers);
    if (map.size) { VCPU.map = map; VCPU.at = now; VCPU.error = null; }
  } catch (e) { VCPU.error = String((e && e.message) || e).slice(0, 200); }
  return VCPU.map;
}
function tierFor(type, cloud) {
  return VCPU.tiers.get(`${type}|${String(cloud || 'SECURE').toUpperCase()}`) || 0;
}
function enrichOffers(list, cfg, map, cap = Infinity) {
  if (!map || !map.size) return list;
  const out = [];
  for (const x of list || []) {
    const rows = map.get(`${x.id}|${String(x.cloudType || 'SECURE').toUpperCase()}`);
    if (!rows) { out.push(x); continue; }   // type not in the answer: keep it, unknown vCPU
    let best = null;
    for (const r of rows) {
      const price = Number.isFinite(r.price) && r.price > 0 ? r.price : Number(x.price);
      if (!(price > 0) || price > cap + 1e-9) continue;
      const slots = expectedSlots(r.vcpu, cfg, x.memoryInGb, `${x.id} ${x.displayName || ''}`);
      const v = slots / price;
      if (!best || v > best.v + 1e-9) best = { v, tier: r.tier, vcpu: r.vcpu, price };
    }
    if (!best) continue;                    // no free host with >= minVcpuPerGpu vCPU (or only above the cap)
    out.push({ ...x, vcpu: best.vcpu, vcpuTier: best.tier, price: best.price });
  }
  return out;
}

// ---- Price-performance (21.11. 13:15Z, owner: "beste Preis-Leistungsverhaeltnis ... auch mal 2 pods wenn es
// Preis-Leistungssieger ist ... niemals sinnlos Geld verballern ... so schnell wie moeglich booten") ----
// Pods mostly render animations on their CPU, so a pod's work = its slots: min(floor(vCPU / cpuPerPodSlot),
// podMaxConcurrency, stock VRAM slots). The offer list has no vCPU count, so the vCPU and boot minutes each GPU
// type + cloud really delivered are learned from our pods (file below). value = slots * (1 - boot / horizon) / price.
const LEARN_FILE = process.env.VF_RUNPOD_LEARN_FILE || '/data/runtime/vf-runpod-learn.json';
const BOOT_DEFAULT_MIN = Object.freeze({ COMMUNITY: 6, SECURE: 24 });
function createLearnStore(file = LEARN_FILE, fsImpl = fs) {
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(fsImpl.readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
    if (!data.types || typeof data.types !== 'object') data.types = {};
    if (!data.pods || typeof data.pods !== 'object') data.pods = {};
    return data;
  };
  const key = (type, cloud) => `${type}|${String(cloud || 'SECURE').toUpperCase()}`;
  const mix = (old, v) => (Number(old) > 0 ? Math.round((Number(old) + v) / 2 * 10) / 10 : Math.round(v * 10) / 10);
  return {
    get(type, cloud) { return load().types[key(type, cloud)] || null; },
    // Once per pod, when it is ready and its vCPU count is known.
    record(pod, vcpu) {
      const d = load();
      if (!pod || !pod.id || !pod.gpuType || d.pods[pod.id]) return false;
      const created = Date.parse(pod.createdAt), ready = Date.parse(pod.readyAt), v = Number(vcpu);
      if (!(v > 0) || !Number.isFinite(created) || !Number.isFinite(ready) || ready < created) return false;
      const k = key(pod.gpuType, pod.cloudType), t = { ...(d.types[k] || {}) };
      t.n = (Number(t.n) || 0) + 1; t.vcpu = mix(t.vcpu, v); t.bootMin = mix(t.bootMin, (ready - created) / 60000);
      t.at = new Date(ready).toISOString();
      d.types[k] = t; d.pods[pod.id] = 1;
      const ids = Object.keys(d.pods);
      if (ids.length > 300) for (const id of ids.slice(0, ids.length - 300)) delete d.pods[id];
      try { fsImpl.writeFileSync(file + '.tmp', JSON.stringify(d, null, 1)); fsImpl.renameSync(file + '.tmp', file); } catch { /* memory only */ }
      return true;
    },
    data: () => load(),
  };
}
const LEARN = globalThis.__vfRunpodLearn || (globalThis.__vfRunpodLearn = createLearnStore());
function vramSlots(memoryInGb, type) {
  const v = Number(memoryInGb);
  if (!(v > 0)) return Infinity;
  const s = Math.max(1, Math.floor((v - 4) / 2));
  return /GeForce/i.test(String(type || '')) ? Math.min(8, s) : s;
}
function expectedSlots(vcpu, cfg, memoryInGb, type) {
  const per = Number(cfg.cpuPerPodSlot) || 2, max = Math.floor(Number(cfg.podMaxConcurrency)) || 12;
  return Math.max(1, Math.min(max, Math.floor(vcpu / per), vramSlots(memoryInGb, type)));
}
function offerValue(x, cfg, learn = LEARN) {
  const price = Number(x && x.price);
  if (!(price > 0)) return 0;
  const l = (learn && learn.get(x.id, x.cloudType)) || {};
  const minV = Number(cfg.minVcpuPerGpu) || 4;
  const vcpu = Number(x.vcpu) > 0 ? Number(x.vcpu) : Math.max(minV, Number(l.vcpu) || 0);
  const boot = Number(l.bootMin) > 0 ? Number(l.bootMin) : (BOOT_DEFAULT_MIN[String(x.cloudType || 'SECURE').toUpperCase()] ?? 20);
  const horizon = Number(cfg.planHorizonMin) || 120;
  return expectedSlots(vcpu, cfg, x.memoryInGb, `${x.id} ${x.displayName || ''}`) * Math.max(0.05, 1 - boot / horizon) / price;
}
function podSlots(p, cfg, cpu = POD_CPU) {
  const s = Math.floor(Number(p && p.safeConcurrency));
  if (s > 0) return Math.min(s, vramSlots(p.vramGb, p.gpuType));
  const v = Number(cpu.get(p && p.id));
  return expectedSlots(v > 0 ? v : (Number(cfg.minVcpuPerGpu) || 4), cfg, p && p.vramGb, p && p.gpuType);
}
function podValue(p, cfg, cpu = POD_CPU) {
  const c = Number(p && p.costPerHr);
  return c > 0 ? podSlots(p, cfg, cpu) / c : 0;
}

// Stock list = in-stock offers within the price cap, cheapest first. 'value' orders by offerValue (best work per
// dollar, boot time included); 'strongest' by GPU type strength (table above), then more VRAM, then cheaper.
function orderOffers(list, cfg, learn = LEARN) {
  const ex = excludeRegex(cfg);
  const min = Number(cfg.minVramGb) || 8;
  const kept = (list || []).filter(x => x && Number(x.memoryInGb) >= min && !(ex && ex.test(`${x.id || ''} ${x.displayName || ''}`)));
  if (cfg.gpuPick === 'value') {
    const v = new Map(kept.map(x => [x, offerValue(x, cfg, learn)]));
    return kept.map((x, i) => ({ x, i })).sort((a, b) => (v.get(b.x) - v.get(a.x))
      || (gpuStrength(b.x, b.x.price) - gpuStrength(a.x, a.x.price)) || (Number(a.x.price) - Number(b.x.price)) || a.i - b.i).map(e => e.x);
  }
  if (cfg.gpuPick !== 'strongest') return kept;
  const maxPrice = new Map();
  for (const x of kept) {
    const p = Number(x.price);
    if (Number.isFinite(p) && p > (maxPrice.get(x.id) || 0)) maxPrice.set(x.id, p);
  }
  const strength = new Map(kept.map(x => [x.id, gpuStrength(x, maxPrice.get(x.id))]));
  const pref = String(cfg.preferCloud || '').toUpperCase();
  const cloudRank = x => (pref && String(x.cloudType || '').toUpperCase() !== pref ? 1 : 0);
  return kept.map((x, i) => ({ x, i })).sort((a, b) =>
    cloudRank(a.x) - cloudRank(b.x)
    || (strength.get(b.x.id) || 0) - (strength.get(a.x.id) || 0)
    || (Number(b.x.memoryInGb) || 0) - (Number(a.x.memoryInGb) || 0)
    || String(a.x.id).localeCompare(String(b.x.id))
    || (Number(a.x.price) || 0) - (Number(b.x.price) || 0)
    || a.i - b.i).map(e => e.x);
}

function wrapGpuList(orig, read, gql, getPods) {
  const wrapped = async function vfRunpodGpuList(...args) {
    const list = await orig.apply(this, args);
    const cfg = read();
    if (!cfg.enabled) return list;
    let offers = list;
    if (cfg.gpuPick === 'value' && cfg.liveVcpu !== false && typeof gql === 'function') {
      const settings = (args[0] && args[0].settings) || {};
      const cap = Number(settings.maxFfmpegHourlyPrice) > 0 ? Number(settings.maxFfmpegHourlyPrice) : Infinity;
      const map = await refreshVcpu(gql, cfg);
      offers = enrichOffers(list, cfg, map, cap);
      for (const x of offers) if (x.vcpuTier) VCPU.tiers.set(`${x.id}|${String(x.cloudType).toUpperCase()}`, x.vcpuTier);
    }
    const ordered = orderOffers(offers, cfg);
    globalThis.__vfRunpodOffers = { at: Date.now(), list: ordered };
    // The stock create loop walks down this list when an offer has no capacity. 13:57Z: the $0.25 offer failed and
    // it took a $0.69 one, above the budget. It only gets offers that fit the room left in maxHourlySpend.
    const max = Number(cfg.maxHourlySpend);
    if (cfg.podScaling !== false && max > 0 && typeof getPods === 'function') {
      let spend = 0;
      try { for (const p of getPods() || []) if (p && (p.state === 'ready' || p.state === 'booting')) spend += Number(p.costPerHr) || 0; } catch { spend = 0; }
      return ordered.filter(x => spend + Number(x.price) <= max + 1e-9);
    }
    return ordered;
  };
  wrapped.__vfOrig = orig;
  return wrapped;
}

// Status polls of a pod render (GET /v1/jobs/<id>?wait=..) are repeated when they time out or the network fails;
// a caller abort (job cancelled) is passed on at once. The stock loop gives up on the first failed poll and deletes
// the job on the pod.
function wrapRenderFetch(orig, read, stats, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  if (typeof orig !== 'function' || orig.__vfOrig) return orig;
  const wrapped = async function vfRenderFetch(url, init = {}) {
    const cfg = read();
    const retries = Math.floor(Number(cfg.renderPollRetries));
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (!cfg.enabled || !(retries > 0) || method !== 'GET' || !/\/v1\/jobs\/[^/?]+\?wait=/.test(String(url))) return orig.call(this, url, init);
    for (let i = 0; ; i++) {
      const sig = init && init.signal;
      try {
        return await orig.call(this, url, i === 0 ? init : { ...init, signal: AbortSignal.timeout(50000) });
      } catch (e) {
        const cancelled = sig && sig.aborted && !(sig.reason && sig.reason.name === 'TimeoutError');
        if (cancelled || i >= retries) throw e;
        stats.renderPollRetries = (stats.renderPollRetries || 0) + 1;
        await sleep(2000 * (i + 1));
      }
    }
  };
  wrapped.__vfOrig = orig;
  return wrapped;
}

function localLease() {
  return { capabilities: { fflow: false, siglip: false, render: false }, podId: null, vfLocal: true, release() {}, reportSuccess() {}, reportFailure() {} };
}

// Per-pod outcome window. 17.11.: an RTX 3090 host whose NVENC really failed produced 543 "Encoder error"
// trims in 20 min; treating every one as a bad source clip kept the broken pod alive. A deterministic error
// only stays a source problem while the pod mostly succeeds.
const POD_WINDOW = 30;
function podWindow(windows, podId) {
  if (!windows.has(podId)) windows.set(podId, []);
  return windows.get(podId);
}
function podLooksBroken(win, cfg) {
  const fails = win.filter(x => !x).length;
  const minFails = Number(cfg.brokenPodMinFailures) || 10;
  const ratio = Number(cfg.brokenPodFailureRatio) || 0.5;
  return fails >= minFails && fails / win.length >= ratio;
}

function wrapAcquire(orig, native, read, stats, now = () => Date.now()) {
  let lastSpin = 0;
  const windows = new Map();
  const wrapLease = lease => {
    if (lease && typeof lease.reportFailure === 'function' && !lease.__vfWrapped) {
      const rf = lease.reportFailure.bind(lease);
      const id = lease.podId || 'pod';
      const record = ok => { const w = podWindow(windows, id); w.push(ok); while (w.length > POD_WINDOW) w.shift(); return w; };
      if (typeof lease.reportSuccess === 'function') {
        const rs = lease.reportSuccess.bind(lease);
        lease.reportSuccess = (...a) => { record(true); return rs(...a); };
      }
      lease.reportFailure = async (err, opts) => {
        const cfg = read();
        const msg = String((err && err.message) || err);
        const win = record(false);
        if (cfg.enabled && cfg.deterministicErrors && new RegExp(cfg.deterministicErrors, 'i').test(msg)) {
          if (!podLooksBroken(win, cfg)) { stats.deterministicFailures++; return undefined; }
          stats.brokenPodEscalations = (stats.brokenPodEscalations || 0) + 1;
        }
        // A poll that timed out because OUR side stalled is not the pod's fault (see transientErrors).
        if (cfg.enabled && cfg.transientErrors && new RegExp(cfg.transientErrors, 'i').test(msg) && !podLooksBroken(win, cfg)) {
          stats.transientFailures = (stats.transientFailures || 0) + 1;
          return undefined;
        }
        return rf(err, opts);
      };
      lease.__vfWrapped = true;
    }
    return lease;
  };
  const wrapped = async function vfRunpodAcquire(o) {
    const cfg = read();
    if (!cfg.enabled) return orig.call(this, o);
    const pool = native.pool();
    const ready = native.readyPods().filter(p => native.podUsable(p));
    if (ready.length) {
      // 21.11. 13:30Z: every freed pod slot went to the pool's own waiters or to the next new call, so the renders
      // waiting in the pod rescue (635, the oldest ones, and the Home Motion recoveries) never got one. While
      // entries wait there, only a call the rescue just granted may take or queue for a pod slot; all others run
      // locally and join the rescue's queue. Grants expire after 15 s.
      if (cfg.rescueFair !== false && !(o && o.vfSpin)) {
        const grants = Array.isArray(globalThis.__vfPodRescueGrants) ? globalThis.__vfPodRescueGrants : null;
        const t0 = Date.now();
        if (grants) while (grants.length && t0 - grants[0] > 15000) grants.shift();
        if (grants && grants.length) grants.shift();
        else {
          let waiting = 0;
          try { waiting = Number(globalThis.__vfPodRescue && globalThis.__vfPodRescue.stats().waiting) || 0; } catch { waiting = 0; }
          if (waiting > 0) { stats.rescueFairLocal = (stats.rescueFairLocal || 0) + 1; return localLease(); }
        }
      }
      if (!native.freePod(ready)) {
        if (pool.waiters.length >= (Number(cfg.podQueueMax) || 0)) { stats.overflowLocal++; return localLease(); }
        stats.podQueued++;
      }
      return wrapLease(await orig.call(this, o));
    }
    stats.noPodLocal++;
    const t = now();
    const booting = (pool.pods || []).some(p => p.state === 'booting');
    if (pool.spinups.size === 0 && !booting && t - lastSpin > (Number(cfg.spinupRetrySec) || 180) * 1000) {
      lastSpin = t;
      stats.spinupTriggers++;
      Promise.resolve().then(() => orig.call(this, o)).then(l => { try { l && l.release && l.release(); } catch {} }, () => {});
    }
    return localLease();
  };
  wrapped.__vfOrig = orig;
  return wrapped;
}

const WORKLOAD_KEYS = ['compositions', 'brollAnalysis', 'siglip', 'animations', 'infographics'];
// 21.11. 08:20Z: with the pod on for animations, b-roll trims also went to it; their Home trim scopes stayed in the
// Home dispatch while they waited for the pod (Home dispatch 29-32 active, Home PC busy on 2-3, pod 20 running +
// 21 waiting). The owner: "Home spinnt fixe alles". brollAnalysis now goes to the pod only during a real ffmpeg
// jam: on at ffmpeg queue >= brollAboveFfmpeg (default onAbove 2000), kept until it drops below offBelow (800).
// 09:30Z: and only while motion graphics are not jammed (render queue <= renderOffBelow): the server render lane
// sat RAM-blocked at 0, so the pod is the only place for long animations (Home takes <= 15 s), while Home has
// 33+ trim slots. Pod trims at ffmpeg 2013 / render 1338 left the pod 12/12 busy and animations waiting.
function wantedWorkloads(c, ffmpegQueued = Infinity, have = {}, renderQueued = 0) {
  const w = {};
  for (const k of WORKLOAD_KEYS) w[k] = (c.workloads || []).includes(k);
  // Owner 21.11. ~22:00 local: "wenn runpod schon laeuft soll er alles machen was er kann. Lass das bitte dabei
  // ... nicht arbeit vom pod wegnehmen". brollAboveFfmpeg 0 (knob, set 20:53Z) = no gate at all: a running pod
  // takes b-roll work at any queue length, also while animations wait. 23:10Z: the render rule below still
  // switched brollAnalysis off whenever one animation waited (pod 1/8 busy with 2629 ffmpeg ops queued).
  if (typeof c.brollAboveFfmpeg === 'number' && c.brollAboveFfmpeg === 0) return w;
  const jam = Number(have.brollAnalysis ? c.offBelow : (c.brollAboveFfmpeg ?? c.onAbove));
  if (w.brollAnalysis && Number.isFinite(jam) && jam > 0 && !(ffmpegQueued >= jam)) w.brollAnalysis = false;
  const renderOff = Number(c.renderOffBelow);
  if (w.brollAnalysis && Number(c.renderOnAbove) > 0 && Number.isFinite(renderOff) && renderQueued > renderOff) w.brollAnalysis = false;
  return w;
}

// Hysteresis controller on the native ffmpeg lane queue.
function createController(native, read, stats, log, now = () => Date.now()) {
  let enabledAt = null;
  const renderOffSeen = new Map();
  const plan = { replace: null, spareSince: null, offersAskedAt: 0 };
  // Budget-driven pod count, value-based replacement and scale-down (see planPods).
  function scalePods(cfg, s) {
    if (cfg.podScaling === false) return null;
    const pool = native.pool() || {};
    const pods = pool.pods || [];
    for (const p of pods) {
      if (!p || p.state !== 'ready') continue;
      try {
        if (LEARN.record(p, POD_CPU.get(p.id))) log(`learned ${p.gpuType} ${p.cloudType}: ${POD_CPU.get(p.id)} vCPU, boot ${((Date.parse(p.readyAt) - Date.parse(p.createdAt)) / 60000).toFixed(1)} min`);
      } catch { /* best effort */ }
    }
    const cache = globalThis.__vfRunpodOffers;
    const t = now();
    if ((!cache || t - cache.at > 5 * 60000) && t - plan.offersAskedAt > 5 * 60000 && typeof native.getGpuList === 'function') {
      plan.offersAskedAt = t;
      Promise.resolve().then(() => native.getGpuList()({ settings: native.settings() })).catch(e => { stats.offerError = String((e && e.message) || e); });
    }
    let rescueWaiting = 0;
    try { rescueWaiting = Number(globalThis.__vfPodRescue && globalThis.__vfPodRescue.stats().waiting) || 0; } catch { rescueWaiting = 0; }
    const waiting = (pool.waiters || []).length + rescueWaiting;
    // A create in progress = a spin-up without a booting pod yet. The stock boot loop of a pod that was stopped
    // while booting keeps its spin-up entry until the boot timeout (14:00Z: 27 min of "creating", no new pod);
    // those are counted out.
    plan.stale = (plan.stale || []).filter(until => until > t);
    const spinups = (pool.spinups && pool.spinups.size) || 0;
    const creating = Math.max(0, spinups - pods.filter(p => p && p.state === 'booting').length - plan.stale.length);
    const decision = planPods({ pods, waiting, offers: (cache && cache.list) || [], now: t, spinning: creating > 0 }, cfg, plan);
    stats.lastPlan = { at: new Date(t).toISOString(), ...decision };
    const target = Math.max(1, pods.length + creating + (decision.spawn ? 1 : 0));
    if (Number(s.maxFfmpegPods) !== target) native.saveSettings({ maxFfmpegPods: target });
    if (decision.spawn) {
      stats.scaleSpawns = (stats.scaleSpawns || 0) + 1;
      log(`pod plan: ${decision.reason}`);
      const first = (pool.waiters || [])[0];
      let jobId = first && first.jobId;
      if (!jobId && globalThis.__vfPodRescue) jobId = (globalThis.__vfPodRescue.rescue.entries.find(e => !e.done) || {}).jobId;
      if (jobId) {
        if (typeof native.spin === 'function' && Array.isArray(pool.waiters)) {
          // The stock spin-up only starts a pod while a pool waiter exists. With the fair hand-off the pool queue is
          // usually empty, and asking the stock acquire took a free slot instead of starting a pod (13:55Z: "spawn"
          // every minute, no pod). A stand-in waiter is there just for the call.
          const standIn = { jobId, timer: null, resolve(l) { try { if (l && l.release) l.release(); } catch { /* ignore */ } }, reject() {} };
          const empty = pool.waiters.length === 0;
          if (empty) pool.waiters.push(standIn);
          try { native.spin(jobId); } catch (e) { stats.spinError = String((e && e.message) || e); }
          const i = pool.waiters.indexOf(standIn);
          if (i >= 0) pool.waiters.splice(i, 1);
        } else if (typeof native.api === 'function') {
          // The stock spin-up needs a pool waiter: ask the stock acquire directly (the wrapper would answer locally).
          const api = native.api(), acquire = api.acquire.__vfOrig || api.acquire;
          Promise.resolve().then(() => acquire.call(api, { jobId, vfSpin: true, checkCanceled() {} }))
            .then(l => { try { if (l && l.release) l.release(); } catch { /* ignore */ } }, e => { stats.spinError = String((e && e.message) || e); });
        }
      }
    }
    if (decision.cancel && typeof native.terminatePod === 'function') {
      const p = pods.find(x => x.id === decision.cancel && x.state === 'booting');
      if (p) {
        stats.scaleCancels = (stats.scaleCancels || 0) + 1;
        plan.stale.push(t + (Number(cfg.bootTimeoutMin) || 30) * 60000);
        log(`pod plan: ${decision.reason}`);
        Promise.resolve(native.terminatePod(p, 'vf-custom pod plan: over budget while booting')).catch(e => { stats.guardError = String(e); });
      }
    }
    if (decision.drain) {
      const p = pods.find(x => x.id === decision.drain);
      if (p && !String(p.image || '').includes('#vf-drain')) {
        p.image = `${p.image}#vf-drain`;
        stats.scaleDrains = (stats.scaleDrains || 0) + 1;
        log(`pod plan: drain ${p.id} (${p.gpuType}, $${p.costPerHr}/h): ${decision.reason}`);
      }
    }
    if (typeof native.terminatePod === 'function') {
      for (const p of pods) {
        if (p.state === 'ready' && !p.inflight && String(p.image || '').includes('#vf-drain')) {
          stats.scaleTerminations = (stats.scaleTerminations || 0) + 1;
          log(`pod plan: terminating drained pod ${p.id}`);
          Promise.resolve(native.terminatePod(p, 'vf-custom pod plan: drained (better value or no work)')).catch(e => { stats.guardError = String(e); });
        }
      }
    }
    return decision;
  }
  function tick() {
    const cfg = read();
    const c = cfg.controller || {};
    if (!cfg.enabled || !(c.enabled || c.combined === true)) return 'off';
    let queued;
    try { queued = native.lane('ffmpeg').waiters.length; } catch { return 'no-lane'; }
    let renderQueued = 0;
    try { renderQueued = native.lane('render').waiters.length; } catch { renderQueued = 0; }
    const renderActive = Number(c.renderOnAbove) > 0;
    const renderOn = renderActive ? Number(c.renderOnAbove) : Infinity;
    const renderOff = Number(c.renderOffBelow) >= 0 ? Number(c.renderOffBelow) : 0;
    const s = native.settings();
    stats.lastQueue = queued;
    stats.lastRenderQueue = renderQueued;
    try {
      const capped = capPodSlots((native.pool() || {}).pods, cfg);
      if (capped) { stats.podSlotCaps = (stats.podSlotCaps || 0) + capped; log(`pod slots capped to CPU (${capped} pod(s))`); }
    } catch (e) { stats.podSlotCapError = String(e); }
    try {
      const back = reenableRender((native.pool() || {}).pods, cfg, native.reprobe || (pod => { if (pod.capabilities) pod.capabilities.render = true; }), renderOffSeen, now());
      if (back) { stats.renderReenabled = (stats.renderReenabled || 0) + back; log(`render re-enabled on ${back} pod(s) after ${cfg.renderRetryMin} min off`); }
    } catch (e) { stats.renderReenableError = String(e); }
    if (!s.gpuFfmpegEnabled && typeof native.terminatePod === 'function') {
      const idleMs = (Number(c.guardIdleMinutes) || 7) * 60000;
      for (const p of (native.pool().pods || [])) {
        if (p.state === 'ready' && !p.inflight && Number.isFinite(p.idleSinceMs) && now() - p.idleSinceMs >= idleMs) {
          stats.guardTerminations = (stats.guardTerminations || 0) + 1;
          log(`cost guard: terminating idle pod ${p.id} (pool off)`);
          Promise.resolve(native.terminatePod(p, 'vf-custom runpod-pool cost guard: pool off and pod idle')).catch(e => { stats.guardError = String(e); });
        }
      }
    }
    if (s.gpuFfmpegEnabled) {
      if (enabledAt === null) enabledAt = now();
      const heldMin = (now() - enabledAt) / 60000;
      if (queued < c.offBelow && (!renderActive || renderQueued <= renderOff) && heldMin >= (Number(c.minOnMinutes) || 0)) {
        native.saveSettings({ gpuFfmpegEnabled: false });
        enabledAt = null;
        stats.switchedOff++;
        stats.lastSwitch = { at: new Date(now()).toISOString(), to: 'off', queued, renderQueued };
        log(`RunPod pool off: ffmpeg queue ${queued} < ${c.offBelow}, render queue ${renderQueued} <= ${renderOff}`);
        return 'switched-off';
      }
      // Hot knob edits of controller.workloads take effect while the pool is already on; brollAnalysis follows
      // the ffmpeg queue (see wantedWorkloads).
      const have = s.workloads || {};
      const want = wantedWorkloads(c, queued, have, renderQueued);
      if (WORKLOAD_KEYS.some(k => Boolean(have[k]) !== want[k])) {
        native.saveSettings({ workloads: want });
        stats.workloadSyncs = (stats.workloadSyncs || 0) + 1;
        log(`RunPod pool workloads synced: ${WORKLOAD_KEYS.filter(k => want[k]).join(', ') || 'none'}`);
      }
      try { scalePods(cfg, s); } catch (e) { stats.scaleError = String((e && e.stack) || e); }
      return 'on';
    }
    if (queued >= c.onAbove || renderQueued >= renderOn) {
      const workloads = wantedWorkloads(c, queued, {}, renderQueued);
      native.saveSettings({ gpuFfmpegEnabled: true, workloads });
      enabledAt = now();
      stats.switchedOn++;
      stats.lastSwitch = { at: new Date(now()).toISOString(), to: 'on', queued, renderQueued };
      log(`RunPod pool on: ffmpeg queue ${queued} (>= ${c.onAbove}?) render queue ${renderQueued} (>= ${renderOn}?)`);
      return 'switched-on';
    }
    return 'idle';
  }
  return { tick };
}

function createRunpodPool(native, { file = FILE, log = m => console.log(`[vf-runpod-pool] ${m}`), setIntervalImpl = setInterval } = {}) {
  const read = createConfigReader(file);
  const stats = { v2create: 0, v2get: 0, v2delete: 0, forcedReady: 0, overflowLocal: 0, podQueued: 0, noPodLocal: 0, spinupTriggers: 0,
    deterministicFailures: 0, switchedOn: 0, switchedOff: 0, lastQueue: null, lastSwitch: null, applied: false, applyError: null };
  const controller = createController(native, read, stats, log);
  let applyTimer = null;
  let ctlTimer = null;

  function applyPatches() {
    const cfg = read();
    if (!cfg.enabled) return false;
    const box = native.overrideBox();
    if (cfg.imageTag) box.override = cfg.imageTag;
    native.timing().bootTimeoutMs = Math.max(8, Number(cfg.bootTimeoutMin) || 25) * 60e3;
    native.timing().opTimeoutMs = Math.max(15, Number(cfg.opTimeoutMin) || 30) * 60e3;
    native.setOfferCount(Math.max(1, Number(cfg.offerCount) || 3));
    const kt = native.getKt();
    if (!kt.__vfOrig) native.setKt(wrapKt(kt, read, stats));
    const gl = native.getGpuList();
    if (!gl.__vfOrig) native.setGpuList(wrapGpuList(gl, read, native.gql, () => (native.pool() || {}).pods));
    const api = native.api();
    if (!api.acquire.__vfOrig) api.acquire = wrapAcquire(api.acquire, native, read, stats);
    const fetchBox = typeof native.renderFetchBox === 'function' ? native.renderFetchBox() : null;
    if (fetchBox && typeof fetchBox.fn === 'function' && !fetchBox.fn.__vfOrig) fetchBox.fn = wrapRenderFetch(fetchBox.fn, read, stats);
    stats.applied = true;
    return true;
  }

  function start() {
    const tryApply = () => {
      try {
        if (!native.ready()) return false;
        applyPatches();
        if (applyTimer) { clearInterval(applyTimer); applyTimer = null; }
        if (!ctlTimer) {
          const sec = Math.max(15, Number((read().controller || {}).checkSec) || 60);
          ctlTimer = setIntervalImpl(() => { try { controller.tick(); } catch (e) { stats.controllerError = String(e); } }, sec * 1000);
          if (ctlTimer && ctlTimer.unref) ctlTimer.unref();
        }
        return true;
      } catch (e) {
        stats.applyError = String(e && e.stack || e);
        return false;
      }
    };
    if (!tryApply()) {
      applyTimer = setIntervalImpl(tryApply, 1000);
      if (applyTimer && applyTimer.unref) applyTimer.unref();
    }
  }

  function stop() {
    if (applyTimer) { clearInterval(applyTimer); applyTimer = null; }
    if (ctlTimer) { clearInterval(ctlTimer); ctlTimer = null; }
  }

  return { start, stop, applyPatches, tick: () => controller.tick(), status: () => ({ ...stats, config: read() }) };
}

module.exports = { createRunpodPool, wrapKt, wrapGpuList, orderOffers, gpuStrength, capPodSlots, reenableRender, planPods, offerValue, podValue, podSlots, wrapRenderFetch, createLearnStore, vramSlots, vcpuQuery, parseVcpu, enrichOffers, refreshVcpu, tierFor, VCPU, wantedWorkloads, POD_CPU, wrapAcquire, createController, createConfigReader, v2CreateBody, v1Shape, DEFAULTS, V1, V2 };
