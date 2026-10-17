const FIELD_KEYS = ['enabled', 'cpuWorkers', 'gpuWorkers', 'siglipEnabled', 'siglipConcurrency', 'sceneWorkers', 'clipvaultBoost', 'ffmpegBoost'];
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
                <label>Scene workers<input class="vc-input" name="sceneWorkers" type="number" min="0" max="25" step="1" required></label>
              </div>
              <div class="vf-pc-boost__boost">
                <h3 class="vf-pc-boost__subtitle">Server boost while the PC is connected</h3>
                <p class="vc-muted vf-pc-boost__hint">Raises these server limits only while the home PC is verified reachable and returns to the normal value as soon as it is not. 0 = off; a value below the normal setting has no effect.</p>
                <div class="vf-pc-boost__limits">
                  <label>ClipVault concurrency<input class="vc-input" name="clipvaultBoost" type="number" min="0" max="200" step="1" required></label>
                  <label>FFmpeg concurrency<input class="vc-input" name="ffmpegBoost" type="number" min="0" max="64" step="1" required></label>
                </div>
                <p class="vf-pc-boost__boost-state" data-boost-state role="status">Boost status unavailable</p>
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
        if (FIELD_KEYS.includes(event.target.name)) this.dirty.add(event.target.name);
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
      if (input.type === 'checkbox') input.checked = data.config[key];
      else {
        input.value = data.config[key];
        if (data.bounds?.[key]) { input.min = data.bounds[key].min; input.max = data.bounds[key].max; }
      }
    }
    this.renderHealth(data.health);
    this.renderBoost(data.boost);
    this.updateButtons();
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
    for (const [key, label] of [['queue','Home PC queue'],['cpu', 'Home PC FFmpeg CPU'], ['gpu', 'Home PC FFmpeg GPU'], ['graphics', 'Home PC GPU Maps / Motion'], ['scene', 'Home PC Scenes'], ['siglip', 'Home PC SigLIP GPU']]) {
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

function renderConcurrency(data) {
  const number = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '?';
  for (const row of document.querySelectorAll('[data-homepc-row]')) {
    const key = row.dataset.homepcRow;
    if(key==='queue'){
      const q=data?.homeQueue;
      row.querySelector('.vc-faint').textContent=q
        ?`${number(q.active)}/${number(q.capacity)} dispatched | ${number(q.queued)} ready`
        :'Queue status unavailable';
      row.classList.toggle('vc-worker-row--busy',Number(q?.active)>0);
      continue;
    }
    const worker = currentWorkerHealth(data?.health, key === 'siglip' ? 'siglip' : 'ffmpeg');
    if (key === 'graphics') {
      row.querySelector('.vc-faint').textContent = Number.isSafeInteger(worker?.graphicsCapacity) && worker.graphicsCapacity >= 1
        ? `${number(worker.graphicsBusy)}/${worker.graphicsCapacity} busy | ${number(worker.completedMap)} maps | ${number(worker.completedMotion)} motion completed (PC total)`
        : 'Graphics worker unavailable; server normal';
      row.classList.toggle('vc-worker-row--busy', Number(worker?.graphicsBusy) > 0);
      continue;
    }
    if (key === 'gpu' && worker?.ready) row.querySelector('strong').textContent = worker.nvencReady === true ? 'Home PC FFmpeg GPU (NVENC)' : 'Home PC GPU decode';
    let active = key === 'siglip' ? worker?.active : worker?.[`${key}Busy`] ?? worker?.[`${key}Active`];
    if (['cpu', 'gpu'].includes(key) && Number.isSafeInteger(active)) active = Math.max(0, active - (worker?.graphicsBusy || 0));
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
    if (key === 'siglip' && Number.isSafeInteger(worker?.gpuConcurrency)) parts.push(`GPU max ${Math.min(1, worker.gpuConcurrency)}`);
    if (key === 'scene' && Number.isSafeInteger(worker?.sceneQueued) && worker.sceneQueued > 0) parts.push(`${worker.sceneQueued} queued on PC`);
    parts.push(Number.isSafeInteger(completed) ? `${completed} completed (PC total)` : 'Completed unavailable');
    if (key === 'siglip' && data?.homeSiglipQueue) {
      const queue = data.homeSiglipQueue;
      parts.push(`${number(queue.active)}/${number(queue.capacity)} admitted`,
        `${number(queue.queued)} eligible queued`, `${number(queue.recovering)} native recoveries`);
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
