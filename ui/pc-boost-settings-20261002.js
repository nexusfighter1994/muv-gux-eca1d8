const FIELD_KEYS = ['enabled', 'cpuWorkers', 'gpuWorkers', 'siglipEnabled', 'siglipConcurrency', 'siglipServerEmbeds', 'earlyPhasePriority', 'sceneWorkers', 'clipvaultBoost', 'ffmpegBoost', 'motionSlots', 'motionHomeShare',
  'burstEnabled', 'burstStartQueue', 'burstStopQueue', 'burstMaxCents', 'burstMaxHours'];
// Shown when an older server does not report these yet (its fixed behaviour).
const FIELD_DEFAULTS = { siglipServerEmbeds: 1, earlyPhasePriority: true, motionSlots: 2, motionHomeShare: 70, burstEnabled: false, burstStartQueue: 200, burstStopQueue: 10, burstMaxCents: 30, burstMaxHours: 12 };
// Write-only: sent only when typed, never filled from the server.
const SECRET_KEYS = ['burstApiKey'];
// Checkbox group: burstGpuType boxes -> burstGpuTypes list.
const LIST_KEYS = { burstGpuTypes: 'burstGpuType' };
const STATUS_REQUEST_TIMEOUT_MS = 6500;

function currentWorkerHealth(health, kind) {
  const checked = Date.parse(health?.checkedAt);
  if (Number.isFinite(checked) && Date.now() - checked > 20000) return { reason: 'timeout' };
  return health?.[kind];
}

function connectionState(worker, gpu = false) {
  if (!worker) return 'Status unavailable';
  if (worker.reason === 'timeout') return 'Status delayed';
  if (worker.reason === 'authentication_unavailable' || worker.reason === 'unauthorized') return 'Authentication failed';
  if (worker.reason === 'invalid_response' || worker.reason === 'http_error') return 'Worker status unavailable';
  if (worker.reachable === false) return 'Disconnected';
  if (!worker.reachable) return 'Status unavailable';
  if (gpu && worker.gpuAvailable === false) return 'GPU unavailable';
  if (!worker.ready) return 'Not ready';
  if (gpu && worker.gpuAvailable !== true) return 'GPU unconfirmed';
  return 'Reachable';
}

class PcBoostSettings extends HTMLElement {
  connectedCallback() {
    if (!this.initialized) {
      this.initialized = true;
      this.dirty = new Set();
      this.bandwidthDirty = new Set();
      this.sequence = 0;
      this.innerHTML = `
        <section class="vf-pc-boost" aria-labelledby="pc-boost-title">
          <header class="vf-pc-boost__head">
            <h2 class="vc-settings__title" id="pc-boost-title">PC Boost</h2>
            <span class="vf-pc-boost__state" data-summary role="status">Checking status</span>
          </header>
          <form>
            <fieldset disabled>
              <div class="vf-pc-boost__toggles">
                <label><input type="checkbox" name="enabled"> PC Boost enabled</label>
                <label><input type="checkbox" name="siglipEnabled"> SigLIP GPU enabled</label>
              </div>
              <div class="vf-pc-boost__limits">
                <label>CPU workers<input class="vc-input" name="cpuWorkers" type="number" min="0" max="25" step="1" required></label>
                <label>GPU encoding workers<input class="vc-input" name="gpuWorkers" type="number" min="0" max="25" step="1" required></label>
                <label>SigLIP concurrency<input class="vc-input" name="siglipConcurrency" type="number" min="1" max="25" step="1" required></label>
                <label>Server SigLIP while PC ready<input class="vc-input" name="siglipServerEmbeds" type="number" min="0" max="25" step="1" required></label>
                <label>Scene workers<input class="vc-input" name="sceneWorkers" type="number" min="0" max="25" step="1" required></label>
              </div>
              <details class="vf-pc-boost__explain" open><summary>What these settings do</summary><dl><dt>PC Boost enabled</dt><dd>Master switch. On: while the home PC is reachable the server hands it FFmpeg jobs, motion graphics, B-roll ranking (SigLIP) and scene detection; whatever the PC cannot take runs on the server as before. Off: everything runs on the server.</dd><dt>SigLIP GPU enabled</dt><dd>B-roll ranking (scores candidate pictures and clips against the script) on the PC graphics card instead of the server CPU. While it is ready the server ranks at most one request itself; OCR always stays on the server.</dd><dt>CPU workers</dt><dd>CPU jobs the PC runs at once: FFmpeg x264 jobs and motion graphics (each running graphic takes one). Rule of thumb: CPU threads minus 4 to 6 (24 threads: 18). Higher = more in parallel, but each job slower and the PC less responsive.</dd><dt>GPU encoding workers</dt><dd>FFmpeg jobs encoded on the graphics card at once (NVENC, QP 14 = visually lossless). Maps take one slot too. Recommended 4 to 6; consumer NVIDIA cards allow only a few encodes at the same time.</dd><dt>SigLIP concurrency</dt><dd>Ranking requests the PC accepts at once. The GPU works through them in batches while the CPU prepares the next pictures. 10 to 20 keeps the GPU busy; more only makes requests wait longer (one that waits over 75 s goes back to the server).</dd><dt>Server SigLIP while PC ready</dt><dd>Rankings the server CPU still does itself while the PC SigLIP is ready (the rest waits for the PC). 1 = server stays free for its other work; 2 to 4 empties the backlog faster but takes CPU from the already busy server. 0 = everything on the PC. When the PC is off the server uses its normal limit. OCR always runs on the server.</dd><dt>Scene workers</dt><dd>Scene-cut detections the PC runs at once (CPU). 0 = off, the server does them.</dd></dl></details>
              <div class="vf-pc-boost__boost">
                <h3 class="vf-pc-boost__subtitle">Server boost while the PC is connected</h3>
                <p class="vc-muted vf-pc-boost__hint">Raises these server limits only while the home PC is verified reachable and returns to the normal value as soon as it is not. 0 = off; a value below the normal setting has no effect.</p>
                <div class="vf-pc-boost__limits">
                  <label>ClipVault concurrency<input class="vc-input" name="clipvaultBoost" type="number" min="0" max="200" step="1" required></label>
                  <label>FFmpeg concurrency<input class="vc-input" name="ffmpegBoost" type="number" min="0" max="64" step="1" required></label>
                </div>
                <details class="vf-pc-boost__explain" open><summary>What these settings do</summary><dl><dt>ClipVault concurrency</dt><dd>While the PC is connected the server runs this many ClipVault (YouTube) downloads at once instead of its normal limit: more B-roll sources in parallel. 0 = off.</dd><dt>FFmpeg concurrency</dt><dd>While the PC is connected the server admits this many FFmpeg jobs at once; many of them run on the PC. Raise it while the PC rows below show free CPU/GPU workers; too high and the server waits for RAM ("Waiting for RAM" in Concurrency).</dd></dl></details>
                <p class="vf-pc-boost__boost-state" data-boost-state role="status">Boost status unavailable</p>
              </div>
              <div class="vf-pc-boost__boost">
                <h3 class="vf-pc-boost__subtitle">Home PC motion graphics</h3>
                <p class="vc-muted vf-pc-boost__hint">Parallel motion graphics the server offers to the home PC, and how much of a graphic's render deadline the PC may use (above 100 % the PC may take longer than the server would; at most 10 minutes per graphic). When the PC takes longer, the server renders that graphic itself with its full deadline. Applies to the next graphic, no restart.</p>
                <div class="vf-pc-boost__limits">
                  <label>Parallel motion graphics<input class="vc-input" name="motionSlots" type="number" min="1" max="8" step="1" required></label>
                  <label>Home PC time share (%)<input class="vc-input" name="motionHomeShare" type="number" min="50" max="200" step="5" required></label>
                </div>
                <details class="vf-pc-boost__explain" open><summary>What these settings do</summary><dl><dt>Parallel motion graphics</dt><dd>Motion graphics the PC renders at once. They run on the PC CPU with the server renderer (same result; measured 2.5 to 4 times faster than the GTX 980 Ti path) and each uses about 3 to 4 CPU threads plus one CPU worker above. Recommended 4 to 6 on 24 threads; the PC accepts at most 8.</dd><dt>Home PC time share (%)</dt><dd>How long the PC may take for one graphic, in % of the server deadline (100 % = same as the server, 200 % = twice as long, at most 10 minutes). If the PC takes longer the server renders that graphic itself with its full deadline, so a video never fails because of the PC. Higher = fewer graphics handed back, but a slow PC can delay them.</dd></dl></details>
              </div>
              <div class="vf-pc-boost__boost">
                <h3 class="vf-pc-boost__subtitle">Job order</h3>
                <label><input type="checkbox" name="earlyPhasePriority"> Prioritize jobs until segment rendering</label>
                <details class="vf-pc-boost__explain" open><summary>What this setting does</summary><dl><dt>Prioritize jobs until segment rendering</dt><dd>On: a video's steps before segment rendering (script, voiceover, audio normalizing and cutting, chunk planning) run before other work in every queue, because they are short and hold the whole video; between such videos the one further along goes first. From segment rendering on the usual order applies: the video closest to finished goes first. Off: finish-first for everything, so new videos can wait a long time at "Cutting voiceovers". Applies within a few seconds, no restart.</dd></dl></details>
              </div>
              <div class="vf-pc-boost__boost">
                <h3 class="vf-pc-boost__subtitle">RunPod GPU burst</h3>
                <p class="vc-muted vf-pc-boost__hint">While at least the start number of motion graphics waits, the server rents the cheapest RunPod GPU pod within the price cap and renders motion graphics there (the server's own renderer, same result). Below the stop number for 5 minutes the pod is terminated. The API key is stored on the server only and never shown again.</p>
                <label><input type="checkbox" name="burstEnabled"> RunPod burst enabled</label>
                <div class="vf-pc-boost__limits">
                  <label>RunPod API key<input class="vc-input" name="burstApiKey" type="password" autocomplete="off" spellcheck="false" placeholder="not set"></label>
                  <label>Start at queued graphics<input class="vc-input" name="burstStartQueue" type="number" min="5" max="5000" step="1" required></label>
                  <label>Stop at queued graphics<input class="vc-input" name="burstStopQueue" type="number" min="0" max="1000" step="1" required></label>
                  <label>Max price (cents per hour)<input class="vc-input" name="burstMaxCents" type="number" min="5" max="300" step="1" required></label>
                  <label>Max pod hours per day<input class="vc-input" name="burstMaxHours" type="number" min="1" max="24" step="1" required></label>
                </div>
                <details class="vf-pc-boost__explain" open><summary>What these settings do</summary><dl><dt>RunPod burst</dt><dd>Optional and off without an API key: rents a cloud GPU only while many motion graphics wait, and stops it again below the stop number. Not needed while the home PC keeps up.</dd><dt>Start / stop at queued graphics</dt><dd>Waiting motion graphics that start the pod, and the number it must stay below for 5 minutes before the pod stops.</dd><dt>Max price / max pod hours</dt><dd>Hard cost limits: only GPUs at or below this hourly price, and at most this many pod hours per day.</dd></dl></details>
                <fieldset class="vf-pc-boost__gpus" data-burst-gpus><legend>GPU types (none selected = any within the price cap; the strongest available is taken)</legend><p class="vc-muted">Save the API key to load the GPU list.</p></fieldset>
                <p class="vf-pc-boost__boost-state" data-burst-state role="status">RunPod status unavailable</p>
              </div>
            </fieldset>
            <div class="vf-pc-boost__telemetry" aria-label="PC worker status">
              <div class="vf-pc-boost__column" aria-hidden="true"><span>Worker</span><span>Connection</span><span>Active</span></div>
              <div><strong>FFmpeg CPU (x264)</strong><span data-state="cpu">Checking</span><output aria-label="Active CPU workers" data-active="cpu">Unavailable</output></div>
              <div><strong data-gpu-label>GPU FFmpeg</strong><span data-state="gpu">Checking</span><output aria-label="Active GPU workers" data-active="gpu">Unavailable</output></div>
              <div><strong>SigLIP GPU</strong><span data-state="siglip">Checking</span><output aria-label="Active SigLIP requests" data-active="siglip">Unavailable</output></div>
              <div><strong>Scene detection</strong><span data-state="scene">Checking</span><output aria-label="Active PC scene detections" data-active="scene">Unavailable</output></div>
            </div>
            <div class="vf-pc-boost__footer">
              <span class="vc-muted" data-checked>Not checked</span>
              <div class="vf-pc-boost__actions">
                <button class="vc-btn vc-btn--ghost vc-btn--sm" type="button" data-refresh>Refresh status</button>
                <button class="vc-btn vc-btn--primary vc-btn--sm" type="submit" disabled>Save changes</button>
              </div>
            </div>
            <p class="vf-pc-boost__message" data-message role="status" aria-live="polite"></p>
          </form>
          <form data-bandwidth-form class="vf-pc-boost__bandwidth">
            <h3 class="vf-pc-boost__subtitle">Home-PC tunnel limits</h3>
            <p class="vc-muted" data-bandwidth-defaults>Default limits unavailable</p>
            <fieldset disabled>
              <div class="vf-pc-boost__limits">
                <label>PC download total (Mbit/s)<input class="vc-input" name="downMbit" type="number" min="1" max="1000" step="1" required></label>
                <label>PC upload total (Mbit/s)<input class="vc-input" name="upMbit" type="number" min="1" max="1000" step="1" required></label>
              </div>
              <label class="vf-pc-boost__uncapped" title="Not supported by the current FFmpeg worker"><input type="checkbox" data-uncapped disabled> Uncapped</label>
            </fieldset>
            <div class="vf-pc-boost__footer">
              <span class="vf-pc-boost__bandwidth-state" data-bandwidth-state role="status">Tunnel limiter offline</span>
              <button class="vc-btn vc-btn--primary vc-btn--sm" type="submit" disabled>Save transfer limits</button>
            </div>
            <p class="vf-pc-boost__message" data-bandwidth-message role="status" aria-live="polite"></p>
          </form>
        </section>`;
      this.form = this.querySelector('form');
      this.form.addEventListener('input', event => {
        if (FIELD_KEYS.includes(event.target.name) || SECRET_KEYS.includes(event.target.name)) this.dirty.add(event.target.name);
        for (const [key, box] of Object.entries(LIST_KEYS)) if (event.target.name === box) this.dirty.add(key);
        this.querySelector('[data-message]').textContent = '';
        this.updateButtons();
      });
      this.form.addEventListener('submit', event => { event.preventDefault(); void this.save(); });
      this.querySelector('[data-refresh]').addEventListener('click', () => void this.refresh());
      this.bandwidthForm = this.querySelector('[data-bandwidth-form]');
      this.bandwidthForm.addEventListener('input', event => {
        if (['downMbit', 'upMbit'].includes(event.target.name)) this.bandwidthDirty.add(event.target.name);
        this.querySelector('[data-bandwidth-message]').textContent = '';
        this.updateBandwidthButtons();
      });
      this.bandwidthForm.addEventListener('submit', event => { event.preventDefault(); void this.saveBandwidth(); });
    }
    void this.refresh();
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible' && this.getClientRects().length && !this.busy) void this.refresh();
    }, 5000);
  }

  disconnectedCallback() {
    clearInterval(this.timer);
    this.controller?.abort();
    this.sequence += 1;
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) {
        const messages = { 401: 'Session expired. Sign in again.', 403: 'Only the workspace owner can change PC Boost.',
          400: url.endsWith('/bandwidth') ? 'Transfer limits must be whole Mbit/s from 1 to 1000.' : 'Check the worker limits.',
          503: 'PC Boost settings are unavailable.' };
        throw new Error(messages[response.status] || 'PC Boost request failed.');
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  updateButtons() {
    this.querySelector('button[type="submit"]').disabled = this.busy || this.bandwidthBusy || !this.config || !this.dirty.size;
    this.querySelector('[data-refresh]').disabled = this.busy || this.bandwidthBusy;
    this.querySelector('fieldset').disabled = this.busy || this.bandwidthBusy || !this.config;
    this.updateBandwidthButtons();
  }

  updateBandwidthButtons() {
    const editable = Boolean(this.bandwidth);
    this.bandwidthForm.querySelector('fieldset').disabled = this.busy || this.bandwidthBusy || !editable;
    this.bandwidthForm.querySelector('button[type="submit"]').disabled = this.busy || this.bandwidthBusy || !editable || !this.bandwidthDirty.size;
  }

  acceptBandwidth(data, saved = false) {
    this.bandwidth = data;
    if (saved) this.bandwidthDirty.clear();
    const rates = data.desired || data.observed || data.defaults;
    this.querySelector('[data-bandwidth-defaults]').textContent = data.defaults
      ? `Default: download ${data.defaults.downMbit} / upload ${data.defaults.upMbit} Mbit/s` : 'Default limits unavailable';
    for (const key of ['downMbit', 'upMbit']) {
      if (this.bandwidthDirty.has(key)) continue;
      const input = this.bandwidthForm.elements.namedItem(key);
      input.value = rates?.[key] ?? '';
      input.min = data.bounds?.min ?? 1;
      input.max = data.bounds?.max ?? 1000;
    }
    const states = { pending: 'Pending tunnel sync', active: 'Tunnel limit active',
      unmanaged: 'Current tunnel limit', bridge_offline: data.desired ? 'Tunnel limiter offline - caps pending' : 'Tunnel limiter offline' };
    const observed = data.observed;
    this.querySelector('[data-bandwidth-state]').textContent = (states[data.status] || 'Transfer status unavailable')
      + (observed ? ` | Down ${observed.downMbit} / Up ${observed.upMbit} Mbit/s`
        : !data.desired && data.defaults ? ' | Defaults shown, not active' : '');
    this.updateBandwidthButtons();
  }

  async refreshBandwidth(sequence) {
    if (this.busy || this.bandwidthBusy || sequence !== this.sequence) return;
    try {
      const data = await this.request('/api/pc-boost/bandwidth');
      if (this.isConnected && sequence === this.sequence) this.acceptBandwidth(data);
    } catch {
      if (this.isConnected && sequence === this.sequence) this.querySelector('[data-bandwidth-state]').textContent = 'Transfer settings unavailable';
    }
  }

  async saveBandwidth() {
    if (this.bandwidthBusy || this.busy || !this.bandwidth || !this.bandwidthForm.reportValidity()) return;
    this.bandwidthBusy = true;
    const sequence = ++this.sequence;
    this.updateButtons();
    const message = this.querySelector('[data-bandwidth-message]');
    message.textContent = 'Saving';
    try {
      const rates = Object.fromEntries(['downMbit', 'upMbit'].map(key => [key, Number(this.bandwidthForm.elements.namedItem(key).value)]));
      const session = await this.request('/api/me');
      if (!session.csrfToken) throw new Error('Session expired. Sign in again.');
      const data = await this.request('/api/pc-boost/bandwidth', { method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify(rates) });
      if (this.isConnected && sequence === this.sequence) {
        this.acceptBandwidth(data, true);
        message.textContent = 'Tunnel limits saved. Pending tunnel sync.';
      }
    } catch (error) {
      if (this.isConnected && sequence === this.sequence) message.textContent = error.name === 'AbortError'
        ? 'Save response timed out. Refresh to check the saved limits.' : error.message;
    } finally { this.bandwidthBusy = false; this.updateButtons(); }
  }

  accept(data, saved = false) {
    this.config = data.config;
    if (saved) this.dirty.clear();
    for (const key of FIELD_KEYS) {
      if (this.dirty.has(key)) continue;
      const input = this.form.elements.namedItem(key);
      if (input.type === 'checkbox') input.checked = data.config[key] ?? FIELD_DEFAULTS[key];
      else {
        input.value = data.config[key] ?? FIELD_DEFAULTS[key];
        if (data.bounds?.[key]) { input.min = data.bounds[key].min; input.max = data.bounds[key].max; }
      }
    }
    const key = this.form.elements.namedItem('burstApiKey');
    if (key && !this.dirty.has('burstApiKey')) { key.value = ''; key.placeholder = data.config.burstApiKeySet ? 'saved (type to replace)' : 'not set'; }
    this.renderBurst(data.config.burstStatus);
    if (!this.dirty.has('burstGpuTypes')) this.renderGpus(data.config.burstStatus?.gpus, data.config.burstGpuTypes ?? [], data.config.burstMaxCents ?? FIELD_DEFAULTS.burstMaxCents);
    this.renderHealth(data.health);
    this.renderBoost(data.boost);
    this.updateButtons();
  }

  renderGpus(gpus, selected, maxCents) {
    const box = this.querySelector('[data-burst-gpus]');
    if (!box) return;
    const legend = box.querySelector('legend').outerHTML;
    if (!Array.isArray(gpus) || !gpus.length) { box.innerHTML = legend + '<p class="vc-muted">Save the API key to load the GPU list.</p>'; return; }
    const known = new Set(gpus.map(g => g.id));
    const rows = [...gpus, ...selected.filter(id => !known.has(id)).map(id => ({ id, name: id, price: null }))];
    box.innerHTML = legend;
    for (const gpu of rows) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.name = 'burstGpuType'; input.value = gpu.id; input.checked = selected.includes(gpu.id);
      const price = Number.isFinite(gpu.price) ? ` · $${gpu.price.toFixed(2)}/h${gpu.price * 100 > maxCents ? ' (above the cap)' : ''}` : ' · not offered now';
      label.append(input, ` ${gpu.name}${gpu.memoryInGb ? ` · ${gpu.memoryInGb} GB` : ''}${price}`);
      box.append(label);
    }
  }

  renderBurst(status) {
    const node = this.querySelector('[data-burst-state]');
    if (!node) return;
    if (!status) { node.textContent = 'RunPod status unavailable'; return; }
    const today = status.ledger ? `today ${(status.ledger.seconds / 3600).toFixed(1)} h, $${(status.ledger.cents / 100).toFixed(2)}` : '';
    const pod = status.pod;
    const text = pod ? `Pod ${pod.ready ? 'ready' : 'starting'}: ${pod.gpu || 'GPU'} at $${Number(pod.costPerHr).toFixed(2)}/h, ${status.inflight} rendering`
      : status.lastError ? `No pod (${status.lastError})` : 'No pod running';
    node.textContent = [text, `${status.queued ?? '?'} graphics queued`, today].filter(Boolean).join(' · ');
  }

  renderBoost(boost) {
    const node = this.querySelector('[data-boost-state]');
    const active = [['FFmpeg', boost?.ffmpeg], ['ClipVault', boost?.clipvault]].filter(([, value]) => Number.isSafeInteger(value) && value > 0);
    node.textContent = !boost ? 'Boost status unavailable' : active.length
      ? `Active now: ${active.map(([name, value]) => `${name} ${value}`).join(' \u00b7 ')}`
      : 'Not active - normal server limits apply';
    node.dataset.active = String(active.length > 0);
  }

  renderHealth(health) {
    const ffmpeg = currentWorkerHealth(health, 'ffmpeg');
    const gpuLabel = this.querySelector('[data-gpu-label]');
    if (gpuLabel && ffmpeg?.ready) gpuLabel.textContent = ffmpeg.nvencReady === true ? 'GPU NVENC High' : 'GPU decode + x264';
    const siglip = currentWorkerHealth(health, 'siglip');
    for (const [key, worker, active, gpu] of [
      ['cpu', ffmpeg, ffmpeg?.cpuBusy ?? ffmpeg?.cpuActive, false],
      ['gpu', ffmpeg, ffmpeg?.gpuBusy ?? ffmpeg?.gpuActive, true],
      ['siglip', siglip, siglip?.active, true],
      ['scene', ffmpeg && { ...ffmpeg, ready: ffmpeg.ready && ffmpeg.sceneReady === true }, ffmpeg?.sceneActive, false],
    ]) {
      this.querySelector(`[data-state="${key}"]`).textContent = connectionState(worker, gpu);
      this.querySelector(`[data-active="${key}"]`).textContent = Number.isSafeInteger(active) && active >= 0 ? String(active) : 'Unavailable';
    }
    const summary = this.querySelector('[data-summary]');
    summary.textContent = !health ? 'Status unavailable' : !this.config.enabled ? 'Disabled' :
      ffmpeg?.ready || (this.config.siglipEnabled && siglip?.ready && siglip?.gpuAvailable === true) ? 'PC reachable' :
      ffmpeg?.reason === 'timeout' || siglip?.reason === 'timeout' ? 'Status delayed' : 'Server normal';
    summary.dataset.enabled = String(Boolean(this.config?.enabled && health));
    const checked = new Date(health?.checkedAt);
    this.querySelector('[data-checked]').textContent = Number.isFinite(checked.getTime()) ? `Checked ${checked.toLocaleTimeString()}` : 'Status unavailable';
  }

  async refresh() {
    if (this.busy || this.bandwidthBusy || this.refreshing) return;
    this.refreshing = true;
    const sequence = ++this.sequence;
    try {
      const data = await this.request('/api/pc-boost');
      if (this.isConnected && sequence === this.sequence) {
        this.accept(data);
        if (this.refreshFailure) this.querySelector('[data-message]').textContent = '';
        this.refreshFailure = false;
      }
    } catch (error) {
      if (this.isConnected && sequence === this.sequence) {
        this.refreshFailure = true;
        this.renderHealth(null);
        this.querySelector('[data-message]').textContent = error.name === 'AbortError' ? 'Status request timed out.' : error.message;
      }
    } finally { await this.refreshBandwidth(sequence); this.refreshing = false; }
  }

  async save() {
    if (this.busy || this.bandwidthBusy || !this.config || !this.form.reportValidity()) return;
    this.busy = true;
    this.refreshFailure = false;
    const sequence = ++this.sequence;
    this.updateButtons();
    const message = this.querySelector('[data-message]');
    message.textContent = 'Saving';
    try {
      const patch = {};
      for (const key of this.dirty) {
        const input = this.form.elements.namedItem(key);
        if (LIST_KEYS[key]) { patch[key] = [...this.form.querySelectorAll(`input[name="${LIST_KEYS[key]}"]:checked`)].map(box => box.value); continue; }
        if (SECRET_KEYS.includes(key)) { if (input.value.trim()) patch[key] = input.value.trim(); continue; }
        patch[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
      }
      const session = await this.request('/api/me');
      if (!session.csrfToken) throw new Error('Session expired. Sign in again.');
      const data = await this.request('/api/pc-boost', {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify(patch),
      });
      if (this.isConnected && sequence === this.sequence) {
        this.accept(data, true);
        message.textContent = 'Settings saved.';
      }
    } catch (error) {
      if (this.isConnected && sequence === this.sequence) message.textContent = error.name === 'AbortError' ? 'Save response timed out. Refresh to check the saved settings.' : error.message;
    } finally { this.busy = false; this.updateButtons(); }
  }
}

if (!customElements.get('pc-boost-settings')) customElements.define('pc-boost-settings', PcBoostSettings);
function mount() {
  mountConcurrency();
  // vf-custom: the PC Boost panel lives on the Custom page only.
  if (!/^\/(settings\/)?custom\/?$/.test(location.pathname)) return;
  const anchor = document.querySelector('#engine-health');
  if (!anchor || document.querySelector('pc-boost-settings')) return;
  const settings = document.createElement('pc-boost-settings');
  settings.id = 'pc-boost';
  anchor.insertAdjacentElement('beforebegin', settings);
}
let scheduled = false;
new MutationObserver(records => {
  if (scheduled || records.every(record => record.target.closest?.('pc-boost-settings'))) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; mount(); });
}).observe(document.documentElement, { childList: true, subtree: true });
mount();

let concurrencyPending = false;
function mountConcurrency() {
  for (const heading of document.querySelectorAll('.vc-progress-panel__title')) {
    if (heading.textContent.trim() !== 'Concurrency') continue;
    const panel = heading.closest('.vc-progress-panel');
    const list = panel?.querySelector('.vc-worker-list');
    if (!list || list.querySelector('[data-homepc-row]')) continue;
    const anchor = [...list.querySelectorAll('.vc-worker-row')].find(row => /FFmpeg/i.test(row.querySelector('strong')?.textContent || ''));
    if (!anchor) continue;
    let previous = anchor;
    for (const [key, label] of [['queue','Home PC queue'],['cpu', 'Home PC FFmpeg CPU'], ['gpu', 'Home PC FFmpeg GPU'], ['motion','Home PC Motion queue (CPU)'], ['graphics', 'Home PC graphics pool'], ['scene', 'Home PC Scenes'], ['siglip', 'Home PC SigLIP GPU']]) {
      const row = document.createElement('li');
      row.className = 'vc-worker-row vf-homepc-row';
      row.dataset.homepcRow = key;
      row.innerHTML = '<span class="vc-worker-row__dot" aria-hidden="true"></span><strong></strong><span class="vc-faint" role="status">Checking PC status</span>';
      row.querySelector('strong').textContent = label;
      previous.insertAdjacentElement('afterend', row);
      previous = row;
    }
    queueMicrotask(refreshConcurrency);
  }
}

function homeMotionSummary(data) {
  const q=data?.homeMotionQueue, count=value=>Number.isSafeInteger(value)&&value>=0?String(value):'?';
  if(!q)return 'Motion queue status unavailable';
  const ram=Number.isSafeInteger(q.serverStagingMb)?`${(q.serverStagingMb/1024).toFixed(1)} GB server staging`:'Server staging unavailable';
  return `${count(q.homeActive)} Home active | ${count(data?.homeMotion?.slots)} slots | ${count(q.queued)} queued candidates | ${count(q.recovering)} server recoveries | ${ram}`;
}

function renderConcurrency(data) {
  const number = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '?';
  for (const row of document.querySelectorAll('[data-homepc-row]')) {
    const key = row.dataset.homepcRow;
    if(key==='motion'){
      row.querySelector('.vc-faint').textContent=homeMotionSummary(data);
      row.classList.toggle('vc-worker-row--busy',Number(data?.homeMotionQueue?.homeActive)>0);
      continue;
    }
    if(key==='queue'){
      const q=data?.homeQueue;
      row.querySelector('.vc-faint').textContent=q
        ?`${number(q.active)}/${number(q.capacity)} dispatched | ${number(q.queued)} ready`
        :'Queue status unavailable';
      row.classList.toggle('vc-worker-row--busy',Number(q?.active)>0);
      continue;
    }
    const worker = currentWorkerHealth(data?.health, key === 'siglip' ? 'siglip' : 'ffmpeg');
    if (key === 'scene' && data?.homeQueue?.scenes) {
      const scenes = data.homeQueue.scenes;
      row.querySelector('strong').textContent = 'Home PC Scenes (CPU / GPU decode)';
      const state = connectionState(worker, false);
      row.querySelector('.vc-faint').textContent = `${state} | ${number(scenes.gpu)} GPU + ${number(scenes.cpu)} CPU completed (since activation) | ${number(scenes.fallback)} server fallbacks`;
      row.classList.remove('vc-worker-row--busy');
      continue;
    }
    if (key === 'graphics') {
      // Shared graphics occupancy must use the shared pool's capacity, not Motion's sub-limit.
      const motion = data?.homeMotion;
      const parts = Number.isSafeInteger(worker?.graphicsCapacity) && worker.graphicsCapacity >= 1
        ? [`${number(worker.graphicsBusy)}/${number(worker.graphicsCapacity)} busy`] : ['Graphics worker unavailable; server normal'];
      if (motion) parts.push(`recent: ${number((motion.opaqueHome ?? 0) + (motion.alphaHome ?? 0))} on PC, ${number(motion.native)} on server`);
      if (Number.isSafeInteger(worker?.graphicsCapacity)) parts.push(`${number(worker.completedMotion)} motion${Number.isSafeInteger(worker.completedAlpha) ? ` + ${worker.completedAlpha} overlays` : ''} | ${number(worker.completedMap)} maps completed (PC total)`);
      row.querySelector('.vc-faint').textContent = parts.join(' | ');
      row.classList.toggle('vc-worker-row--busy', Number(worker?.graphicsBusy) > 0);
      continue;
    }
    if (key === 'gpu' && worker?.ready) row.querySelector('strong').textContent = worker.nvencReady === true ? 'Home PC FFmpeg GPU (NVENC)' : 'Home PC GPU decode';
    let active = key === 'siglip' ? worker?.active : worker?.[`${key}Busy`] ?? worker?.[`${key}Active`];
    // Motion graphics hold a CPU lease (CPU render), not a GPU one: only the CPU row excludes them.
    if (key === 'cpu' && Number.isSafeInteger(active)) active = Math.max(0, active - (worker?.graphicsBusy || 0));
    const capacity = key === 'siglip' ? worker?.acceptedConcurrency : key === 'scene' ? worker?.sceneWorkers ?? worker?.sceneCapacity : worker?.[`${key}Capacity`];
    const completed = key === 'siglip' ? worker?.completed : worker?.[{ cpu: 'completedCpu', gpu: 'completedGpu', scene: 'completedScene' }[key]];
    const enabled = data?.config?.enabled && (key !== 'siglip' || data.config.siglipEnabled);
    const parts = [];
    const state = connectionState(key === 'scene' && worker ? { ...worker, ready: worker.ready && worker.sceneReady === true } : worker,
      key === 'gpu' || key === 'siglip');
    if (data?.config && !enabled) parts.push('Disabled', 'server normal');
    else if (state !== 'Reachable') {
      parts.push(state);
      if (['Disconnected', 'Authentication failed', 'GPU unavailable', 'Not ready'].includes(state)) parts.push('server normal');
    }
    parts.push(Number.isSafeInteger(active) ? `${active}/${number(capacity)} busy` : 'Busy unavailable');
    if (key === 'scene' && Number.isSafeInteger(worker?.sceneQueued) && worker.sceneQueued > 0) parts.push(`${worker.sceneQueued} queued on PC`);
    parts.push(Number.isSafeInteger(completed) ? `${completed} completed (PC total)` : 'Completed unavailable');
    if (key === 'siglip' && data?.homeSiglipQueue) {
      const queue = data.homeSiglipQueue;
      parts.push(`${number(queue.active)}/${number(queue.capacity)} admitted`,
        `${number(queue.queued)} eligible queued`, `${number(queue.recovering)} native recoveries`);
    }
    // While the PC is ready the server runs at most one embedding itself; the rest waits for the PC.
    if (key === 'siglip' && data?.siglipServer) {
      parts.push(`server ${number(data.siglipServer.embeds)}/${number(data.siglipServer.max)} embeddings`, `${number(data.siglipServer.waitingForPc)} waiting for PC`);
    }
    row.querySelector('.vc-faint').textContent = parts.join(' | ');
    row.classList.toggle('vc-worker-row--busy', Number.isSafeInteger(active) && active > 0);
  }
}

async function refreshConcurrency() {
  if (concurrencyPending || document.visibilityState === 'hidden' || ![...document.querySelectorAll('[data-homepc-row]')].some(row => row.getClientRects().length)) return;
  concurrencyPending = true;
  const controller = new AbortController();
  // The server can legitimately spend 5 seconds checking a busy Home tunnel.
  const timer = setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('/api/pc-boost', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('PC status unavailable');
    const data=await response.json();
    try{
      const queue=await fetch('/api/pc-boost/home-queue',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if(queue.ok)data.homeQueue=await queue.json();
    }catch{}
    renderConcurrency(data);
  } catch { renderConcurrency(null); }
  finally { clearTimeout(timer); concurrencyPending = false; }
}
setInterval(refreshConcurrency, 3000);
