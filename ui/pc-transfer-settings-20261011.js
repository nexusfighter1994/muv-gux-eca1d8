(() => {
  const fields = {
    ffmpegMaxFileMb: ['FFmpeg CPU/GPU per input file (MiB)', 4096],
    ffmpegMaxTotalMb: ['FFmpeg CPU/GPU total inputs per job (MiB)', 4096],
    sceneMaxFileMb: ['Scene source per file (MiB)', 4096],
    siglipMaxImageMb: ['SigLIP per image (MiB)', 128],
  };

  class PcTransferSettings extends HTMLElement {
    connectedCallback() {
      if (!this.initialized) {
        this.initialized = true;
        this.dirty = new Set();
        this.sequence = 0;
        this.innerHTML = `
          <section class="vf-pc-transfer" aria-labelledby="pc-transfer-title">
            <h3 class="vf-pc-boost__subtitle" id="pc-transfer-title">Home-PC offload file sizes</h3>
            <form>
              <fieldset disabled>
                <div class="vf-pc-boost__limits">${Object.entries(fields).map(([key, [label, maximum]]) =>
                  `<label>${label}<input class="vc-input" type="number" name="${key}" min="1" max="${maximum}" step="1" required></label>`).join('')}</div>
              </fieldset>
              <div class="vf-pc-transfer__readback">
                <div><span>FFmpeg CPU/GPU / Scenes</span><output data-transfer-worker="ffmpeg">Unavailable</output></div>
                <div><span>SigLIP</span><output data-transfer-worker="siglip">Unavailable</output></div>
              </div>
              <div class="vf-pc-boost__footer">
                <span data-transfer-state role="status">Checking size settings</span>
                <div class="vf-pc-boost__actions">
                  <button class="vc-btn vc-btn--ghost vc-btn--sm" type="button" data-transfer-refresh>Refresh</button>
                  <button class="vc-btn vc-btn--primary vc-btn--sm" type="submit" disabled>Save file sizes</button>
                </div>
              </div>
              <p class="vf-pc-boost__message" data-transfer-message role="status" aria-live="polite"></p>
            </form>
          </section>`;
        this.form = this.querySelector('form');
        this.form.addEventListener('input', event => {
          if (Object.hasOwn(fields, event.target.name)) this.dirty.add(event.target.name);
          this.querySelector('[data-transfer-message]').textContent = '';
          this.refreshError = false;
          this.updateButtons();
        });
        this.form.addEventListener('submit', event => { event.preventDefault(); void this.save(); });
        this.querySelector('[data-transfer-refresh]').addEventListener('click', () => void this.refresh());
      }
      clearInterval(this.timer);
      void this.refresh();
      this.timer = setInterval(() => {
        if (document.visibilityState === 'visible' && this.getClientRects().length) void this.refresh();
      }, 5000);
    }

    disconnectedCallback() {
      clearInterval(this.timer);
      this.controller?.abort();
      this.sequence++;
    }

    async request(url, options = {}) {
      const controller = new AbortController();
      this.controller = controller;
      const timer = setTimeout(() => controller.abort(), 6500);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) {
          const message = response.status === 401 ? 'Session expired. Sign in again.' : response.status === 403
            ? 'Owner permission or a new session is required.' : response.status === 400
              ? 'Check the file-size values.' : `Offload size settings unavailable (HTTP ${response.status}).`;
          throw new Error(message);
        }
        return await response.json();
      } finally { clearTimeout(timer); }
    }

    updateButtons() {
      this.form.querySelector('fieldset').disabled = this.busy || !this.state;
      this.form.querySelector('button[type="submit"]').disabled = this.busy || !this.state || !this.dirty.size;
      this.querySelector('[data-transfer-refresh]').disabled = this.busy || this.refreshing;
    }

    accept(data, saved = false) {
      if (!data || typeof data.limits !== 'object' || Object.keys(fields).some(key =>
        !Number.isSafeInteger(data.limits[key]) || data.limits[key] < 1 || data.limits[key] > fields[key][1])) {
        throw new Error('Invalid offload size readback.');
      }
      this.state = data;
      if (saved) this.dirty.clear();
      for (const [key, [, maximum]] of Object.entries(fields)) {
        if (this.dirty.has(key)) continue;
        const input = this.form.elements.namedItem(key);
        input.value = data.limits[key];
        input.min = data.bounds?.[key]?.min ?? 1;
        input.max = data.bounds?.[key]?.max ?? maximum;
      }
      const states = { defaults: 'Current server defaults', pending: 'Worker sync pending', active: 'Offload size limits active',
        worker_offline: 'PC offline - saved limits pending', server_reload_pending: 'Server sender update pending deployment' };
      this.querySelector('[data-transfer-state]').textContent = states[data.status] || 'Size status unavailable';
      const ffmpeg = data.workers?.ffmpeg?.observed;
      const siglip = data.workers?.siglip?.observed;
      this.querySelector('[data-transfer-worker="ffmpeg"]').textContent = ffmpeg
        ? `${ffmpeg.ffmpegMaxFileMb} MiB/file | ${ffmpeg.ffmpegMaxTotalMb} MiB/job | Scenes ${ffmpeg.sceneMaxFileMb} MiB`
          + (data.senderActivation?.ffmpeg === false || data.senderActivation?.scenes === false
            ? ' | Receiver ready; sender update pending deployment' : '') : 'Unavailable';
      this.querySelector('[data-transfer-worker="siglip"]').textContent = siglip ? `${siglip.siglipMaxImageMb} MiB/image`
        + (data.senderActivation?.siglip === false ? ' | Receiver ready; sender update pending deployment' : '') : 'Unavailable';
      this.updateButtons();
    }

    async refresh() {
      if (this.busy || this.refreshing) return;
      this.refreshing = true;
      const sequence = ++this.sequence;
      this.updateButtons();
      try {
        const data = await this.request('/api/pc-boost/transfer-limits');
        if (this.isConnected && sequence === this.sequence) {
          this.accept(data);
          if (this.refreshError) this.querySelector('[data-transfer-message]').textContent = '';
          this.refreshError = false;
        }
      } catch (error) {
        if (this.isConnected && sequence === this.sequence) {
          this.querySelector('[data-transfer-state]').textContent = 'Size settings unavailable';
          this.querySelector('[data-transfer-message]').textContent = error.name === 'AbortError' ? 'Status request timed out.' : error.message;
          this.refreshError = true;
        }
      } finally { this.refreshing = false; this.updateButtons(); }
    }

    async save() {
      if (this.busy || !this.state || !this.dirty.size || !this.form.reportValidity()) return;
      this.busy = true;
      const sequence = ++this.sequence;
      const message = this.querySelector('[data-transfer-message]');
      this.refreshError = false;
      message.textContent = 'Saving';
      this.updateButtons();
      try {
        const patch = Object.fromEntries([...this.dirty].map(key => [key, Number(this.form.elements.namedItem(key).value)]));
        const session = await this.request('/api/me');
        if (!session.csrfToken) throw new Error('Session expired. Sign in again.');
        const data = await this.request('/api/pc-boost/transfer-limits', { method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify(patch) });
        if (this.isConnected && sequence === this.sequence) {
          this.accept(data, true);
          message.textContent = data.status === 'server_reload_pending'
            ? 'File sizes saved. Server sender update pending deployment.' : 'File sizes saved. Worker sync pending.';
        }
      } catch (error) {
        if (this.isConnected && sequence === this.sequence) message.textContent = error.name === 'AbortError'
          ? 'Save response timed out. Refresh to check saved values.' : error.message;
      } finally { this.busy = false; this.updateButtons(); }
    }
  }

  if (!customElements.get('pc-transfer-settings')) customElements.define('pc-transfer-settings', PcTransferSettings);
  function mount() {
    if (!/^\/(settings\/)?custom\/?$/.test(location.pathname)) return;
    const parent = document.querySelector('pc-boost-settings .vf-pc-boost');
    if (parent && !parent.querySelector('pc-transfer-settings')) parent.appendChild(document.createElement('pc-transfer-settings'));
  }
  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
})();
