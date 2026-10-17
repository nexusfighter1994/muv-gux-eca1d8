(() => {
  const GROUPS = [['production', 'Produktion'], ['providers', 'LLM/Provider'], ['rendering', 'Rendering'], ['home', 'Home-PC'], ['safety', 'Sicherheit']];
  const FIELDS = [
    { key: 'maxActiveVideos', mod: 'queueLimit', group: 'production', label: 'Gleichzeitige Videos', min: 1, max: 200, hint: 'Begrenzt neue Starts; laufende Videos werden nicht abgebrochen.' },
    { key: 'autoRetryFailed', mod: 'autoRetry', group: 'production', label: 'Wiederholungen pro fehlgeschlagenem Video', min: 0, max: 10, hint: '0 deaktiviert automatische Wiederholungen. Gespeicherte Arbeit bleibt erhalten.' },
    { key: 'surplusFirst', mod: 'surplusRouting', group: 'providers', label: 'Surplus auf geeigneten Routen bevorzugen', type: 'boolean', hint: 'Native Vorgaben, festgelegte Modelle und ausgeschlossene Scorer bleiben erhalten.' },
    { key: 'surplusInsertEfforts', mod: 'surplusRouting', group: 'providers', label: 'Effort-Schritte in Reihenfolge', type: 'efforts', hint: 'Ein bis fuenf Schritte fuer geeignete Routen ohne vorhandenen Surplus-Schritt.' },
    { key: 'surplusAttempts', mod: 'surplusRetry', group: 'providers', label: 'Mindestversuche pro Surplus-Aufruf', min: 1, max: 10, hint: 'Hoehere native Versuchslimits bleiben bestehen.' },
    { key: 'surplusRetryMinSec', mod: 'surplusRetry', group: 'providers', label: 'Minimale Wiederholungspause', min: 0, max: 120, unit: 's', hint: 'Untergrenze der zufaelligen Pause.' },
    { key: 'surplusRetryMaxSec', mod: 'surplusRetry', group: 'providers', label: 'Maximale Wiederholungspause', min: 0, max: 120, unit: 's', hint: 'Laengere Retry-After-Vorgaben des Providers haben Vorrang.' },
    { key: 'surplusIgnoreBreaker', mod: 'surplusRetry', group: 'providers', label: 'Surplus bei Ueberlast weiter versuchen', type: 'boolean', hint: 'Uebersteuert den nativen Circuit Breaker fuer Surplus.' },
  ];
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const onOff = value => value === true ? 'Ein' : value === false ? 'Aus' : 'Unbekannt';
  const display = value => value === undefined || value === null ? 'Nicht gemeldet'
    : typeof value === 'boolean' ? onOff(value) : Array.isArray(value) ? value.join(' > ') : String(value);
  function element(tag, className, text, attributes = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  function button(text, action, attributes = {}) {
    const node = element('button', 'vc-btn vc-btn--ghost vc-btn--sm', text, { type: 'button', ...attributes });
    node.addEventListener('click', action);
    return node;
  }

  class ModSettings extends HTMLElement {
    connectedCallback() {
      if (!this.initialized) {
        this.initialized = true;
        this.views = new Map(); this.groups = new Map(); this.fieldViews = new Map(); this.forms = new Map();
        this.draft = new Map(); this.base = new Map(); this.fieldDraft = new Map(); this.fieldBase = new Map();
        this.controllers = new Set(); this.sequences = {}; this.settingsConflicts = new Set(); this.serial = 0;
        this.build();
        this.beforeUnload = event => {
          if (this.draft.size || this.fieldDraft.size) { event.preventDefault(); event.returnValue = ''; }
        };
      }
      window.addEventListener('beforeunload', this.beforeUnload);
      clearInterval(this.timer);
      this.timer = setInterval(() => { if (document.visibilityState === 'visible') void this.refresh(); }, 15000);
      void this.refresh();
    }

    disconnectedCallback() {
      clearInterval(this.timer); this.timer = null;
      for (const controller of this.controllers) controller.abort();
      window.removeEventListener('beforeunload', this.beforeUnload);
      for (const key of Object.keys(this.sequences)) this.sequences[key]++;
    }

    build() {
      this.className = 'vfc-editor';
      const toolbar = element('div', 'vfc-toolbar');
      const searchLabel = element('label', 'vfc-search', 'Mods und Einstellungen suchen');
      this.search = element('input', 'vc-input', undefined, { type: 'search', 'aria-label': 'Mods und Einstellungen suchen' });
      searchLabel.append(this.search);
      this.search.addEventListener('input', () => this.filter());
      this.refreshButton = button('Status aktualisieren', () => void this.refresh());
      this.checked = element('span', 'vc-muted vfc-checked', 'Wird geladen');
      toolbar.append(searchLabel, this.refreshButton, this.checked);
      const nav = element('nav', 'vfc-nav', undefined, { 'aria-label': 'Custom-Bereiche' });
      this.append(toolbar, nav);
      for (const [id, title] of GROUPS) {
        const section = element('section', 'vfc-group', undefined, { id: `vfc-group-${id}`, 'data-vfc-group': id });
        const list = element('div', 'vfc-mod-list');
        section.append(element('h2', 'vc-settings__title', title), list); this.append(section);
        this.groups.set(id, { section, list });
        nav.append(element('a', '', title, { href: `#vfc-group-${id}` }));
      }
      const home = document.getElementById('pc-boost-host');
      if (home) this.groups.get('home').section.append(home);
      this.noResults = element('p', 'vc-muted', 'Keine passenden Mods.', { hidden: '' });
      this.footer = element('div', 'vfc-savebar');
      this.count = element('span', 'vc-muted');
      this.message = element('p', 'vfc-message', '', { 'data-mod-message': '', role: 'status', 'aria-live': 'polite' });
      this.modsError = element('p', 'vfc-message vfc-error', '', { role: 'status' });
      this.settingsError = element('p', 'vfc-message vfc-error', '', { role: 'status' });
      this.review = button('Entwurf behalten', () => this.reviewMods(), { 'data-review-mods': '', hidden: '' });
      this.discard = button('Mod-Entwurf verwerfen', () => {
        this.draft.clear(); this.base.clear(); this.modConflict = false;
        if (this.snapshot) this.acceptMods(this.snapshot);
        this.message.textContent = 'Mod-Entwurf verworfen.';
      });
      this.save = button('Mod-Schalter speichern', () => void this.saveMods(), { 'data-save-mods': '' });
      this.save.classList.add('vc-btn--primary');
      const actions = element('div', 'vfc-actions'); actions.append(this.review, this.discard, this.save);
      this.footer.append(this.count, actions, this.message);
      this.append(this.noResults, this.modsError, this.settingsError, this.footer);
      for (const field of FIELDS) this.addField(field);
      this.updateButtons();
    }

    createMod(mod) {
      const root = element('article', 'vfc-mod', undefined, { 'data-mod-id': mod.id });
      const head = element('div', 'vfc-mod-head');
      const details = element('details', 'vfc-mod-details');
      const summary = element('summary', 'vfc-mod-title', 'Einstellungen und Installation');
      const title = element('h3', 'vfc-mod-name', mod.title);
      const description = element('p', 'vfc-description', mod.description);
      const body = element('div', 'vfc-mod-body'); details.append(summary, body);
      const toggleLabel = element('label', 'vfc-toggle');
      const toggle = element('input', '', undefined, { type: 'checkbox', 'data-mod-toggle': mod.id, 'aria-label': `${mod.title}: gewuenschter Zustand` });
      toggleLabel.append(toggle, element('span', '', 'Aktiviert'));
      const state = element('p', 'vfc-state');
      const hooks = element('p', 'vc-muted vfc-hooks'); body.append(hooks);
      head.append(title, toggleLabel); root.append(head, description, state, details);
      toggle.addEventListener('change', () => {
        const current = this.snapshot?.mods.find(item => item.id === mod.id);
        if (!current || this.modsBusy || this.readOnly(current)) return;
        if (!this.base.has(mod.id)) this.base.set(mod.id, current.enabled);
        if (toggle.checked === current.enabled) { this.draft.delete(mod.id); this.base.delete(mod.id); }
        else this.draft.set(mod.id, toggle.checked);
        this.paintMod(current); this.updateButtons();
      });
      const view = { root, title, description, body, toggle, details, state, hooks };
      this.views.set(mod.id, view); return view;
    }

    readOnly(mod) { return mod.readOnly === true || mod.toggleable === false || mod.alwaysOn === true; }

    validateMods(data) {
      if (!data || !(data.revision === null || typeof data.revision === 'string') || !Array.isArray(data.mods) || !Array.isArray(data.groups)) throw new Error('Ungueltige Mod-Antwort.');
      const ids = new Set();
      for (const mod of data.mods) {
        if (!mod || typeof mod.id !== 'string' || ids.has(mod.id) || typeof mod.title !== 'string'
          || typeof mod.description !== 'string' || typeof mod.enabled !== 'boolean'
          || typeof mod.effective !== 'boolean' || !this.groups.has(mod.group)) throw new Error('Ungueltige Mod-Beschreibung oder Gruppe.');
        ids.add(mod.id);
      }
      return data;
    }

    acceptMods(data) {
      this.validateMods(data);
      for (const mod of data.mods) if (this.draft.has(mod.id) && this.base.get(mod.id) !== mod.enabled) this.modConflict = true;
      if ([...this.draft.keys()].some(id => !data.mods.some(mod => mod.id === id))) this.modConflict = true;
      this.snapshot = data;
      for (const [id, view] of this.views) if (!data.mods.some(mod => mod.id === id)) {
        if (this.draft.has(id)) { view.toggle.disabled = true; view.state.textContent = 'Mod nicht mehr im Register. Entwurf pruefen.'; }
        else { view.root.remove(); this.views.delete(id); }
      }
      for (const mod of data.mods) {
        const view = this.views.get(mod.id) || this.createMod(mod);
        const parent = this.groups.get(mod.group).list;
        if (view.root.parentElement !== parent) parent.append(view.root);
        view.title.textContent = mod.title; view.description.textContent = mod.description;
        view.toggle.setAttribute('aria-label', `${mod.title}: gewuenschter Zustand`);
        this.paintMod(mod);
        const form = this.forms.get(mod.id);
        if (form && form.node.parentElement !== view.body) view.body.append(form.node);
      }
      if (this.modConflict) this.message.textContent = 'Serverwerte wurden geaendert. Entwurf pruefen und bewusst behalten oder verwerfen.';
      this.filter(); this.updateButtons(); this.paintFields();
    }

    paintMod(mod) {
      const view = this.views.get(mod.id);
      view.toggle.checked = this.draft.has(mod.id) ? this.draft.get(mod.id) : mod.enabled;
      view.toggle.disabled = this.modsBusy || this.readOnly(mod);
      const pending = mod.pendingRestart === true || mod.enabled !== mod.effective;
      const values = [`Gespeichert: ${onOff(mod.enabled)}`, `Wirksam: ${onOff(mod.effective)}`, `Standard: ${display(mod.defaultEnabled)}`];
      if (this.draft.has(mod.id)) values.push(`Entwurf: ${onOff(this.draft.get(mod.id))}`);
      if (pending) values.push('Neustart erforderlich');
      else if (mod.restartRequired) values.push('Aenderungen gelten nach Neustart');
      if (this.readOnly(mod)) values.push(mod.alwaysOnReason || mod.disabledReason || 'Erforderliche Infrastruktur');
      view.state.textContent = values.join(' | '); view.state.dataset.pending = String(pending);
      const hooks = Array.isArray(mod.hooks) ? mod.hooks : [];
      const reports = this.status?.build?.report;
      view.hooks.textContent = hooks.length ? `Installation: ${reports ? `${hooks.filter(key => reports[key] === 'ok').length}/${hooks.length} Hooks installiert` : 'Noch nicht geprueft'} | ${hooks.join(', ')}` : 'Installation: kein separater Build-Hook';
    }

    reviewMods() {
      if (!this.snapshot || this.modsBusy || this.modsError.textContent) return;
      for (const [id, desired] of this.draft) {
        const current = this.snapshot.mods.find(mod => mod.id === id);
        if (!current || this.readOnly(current) || current.enabled === desired) { this.draft.delete(id); this.base.delete(id); }
        else this.base.set(id, current.enabled);
      }
      this.modConflict = false;
      this.message.textContent = 'Entwurf mit den aktuellen Serverwerten abgeglichen. Erneut speichern.';
      this.acceptMods(this.snapshot);
    }

    addField(field) {
      let form = this.forms.get(field.mod);
      if (!form) {
        const node = element('form', 'vfc-settings-form', undefined, { 'data-settings-form': field.mod });
        const fields = element('div', 'vfc-settings-fields');
        const actions = element('div', 'vfc-actions');
        const save = element('button', 'vc-btn vc-btn--primary vc-btn--sm', 'Einstellungen speichern', { type: 'submit', 'data-settings-save': field.mod });
        const discard = button('Entwurf verwerfen', () => this.discardSettings(field.mod));
        const review = button('Entwurf behalten', () => {
          for (const item of FIELDS.filter(item => item.mod === field.mod)) {
            this.fieldBase.set(item.key, this.settings.settings[item.key]); this.settingsConflicts.delete(item.key);
          }
          form.message.textContent = 'Aktuelle Serverwerte geprueft. Erneut speichern.'; this.paintFields(); this.updateButtons();
        }, { hidden: '' });
        const message = element('p', 'vfc-message', '', { 'data-settings-message': field.mod, role: 'status', 'aria-live': 'polite' });
        actions.append(discard, review, save); node.append(fields, actions, message);
        node.addEventListener('submit', event => { event.preventDefault(); void this.saveSettings(field.mod); });
        form = { node, fields, save, discard, review, message }; this.forms.set(field.mod, form);
        this.groups.get(field.group).list.append(node);
      }
      const row = element('div', 'vfc-field', undefined, { 'data-field': field.key });
      const id = `vfc-input-${++this.serial}`;
      const label = element('label', 'vfc-field-label', field.label, { for: id });
      const hint = element('p', 'vc-muted vfc-hint', field.hint, { id: `${id}-hint` });
      const meta = element('p', 'vc-muted vfc-meta', '', { id: `${id}-meta` });
      const controls = []; const controlHost = element('div', 'vfc-control');
      if (field.type === 'efforts') {
        controlHost.classList.add('vfc-efforts');
        for (let i = 0; i < 5; i++) {
          const select = element('select', 'vc-input', undefined, { id: i ? `${id}-${i}` : id, 'aria-label': `${field.label}, Schritt ${i + 1}` });
          select.append(element('option', '', 'Kein Schritt', { value: '' }));
          for (const effort of EFFORTS) select.append(element('option', '', effort, { value: effort }));
          controls.push(select); controlHost.append(select);
        }
      } else {
        const control = element('input', field.type === 'boolean' ? '' : 'vc-input', undefined, { id, name: field.key, type: field.type === 'boolean' ? 'checkbox' : 'number' });
        if (field.type !== 'boolean') { control.min = field.min; control.max = field.max; control.step = '1'; control.required = true; }
        controls.push(control); controlHost.append(control);
        if (field.unit) controlHost.append(element('span', 'vc-muted', field.unit));
      }
      for (const control of controls) {
        control.disabled = true; control.setAttribute('aria-describedby', `${id}-hint ${id}-meta`);
        const change = () => {
          if (!this.settings) return;
          if (!this.fieldBase.has(field.key)) this.fieldBase.set(field.key, this.settings.settings[field.key]);
          const value = this.readField(field.key);
          if (same(value, this.settings.settings[field.key])) { this.fieldDraft.delete(field.key); this.fieldBase.delete(field.key); this.settingsConflicts.delete(field.key); }
          else this.fieldDraft.set(field.key, value);
          form.message.textContent = ''; this.paintFields(); this.updateButtons();
        };
        control.addEventListener('input', change); control.addEventListener('change', change);
      }
      const reset = button('Standard', () => {
        const value = this.settings?.defaults?.[field.key];
        if (value === undefined) return;
        this.writeField(field.key, value); controls[0].dispatchEvent(new Event('change', { bubbles: true }));
      }, { 'aria-label': `${field.label}: Standard als Entwurf uebernehmen` });
      reset.disabled = true; controlHost.append(reset);
      const text = element('div', 'vfc-field-copy'); text.append(label, hint, meta);
      row.append(text, controlHost); form.fields.append(row);
      this.fieldViews.set(field.key, { field, row, controls, meta, reset });
    }

    readField(key) {
      const { field, controls } = this.fieldViews.get(key);
      if (field.type === 'boolean') return controls[0].checked;
      if (field.type === 'efforts') return controls.map(node => node.value).filter(Boolean);
      return controls[0].value === '' ? '' : Number(controls[0].value);
    }

    writeField(key, value) {
      const { field, controls } = this.fieldViews.get(key);
      if (field.type === 'boolean') controls[0].checked = value === true;
      else if (field.type === 'efforts') controls.forEach((node, i) => { node.value = value?.[i] || ''; });
      else controls[0].value = value ?? '';
    }

    validateSettings(data) {
      if (!data?.settings || !data.defaults || FIELDS.some(field => {
        const value = data.settings[field.key];
        return field.type === 'boolean' ? typeof value !== 'boolean' : field.type === 'efforts'
          ? !Array.isArray(value) || value.length < 1 || value.length > 5 || value.some(item => !EFFORTS.includes(item))
          : !Number.isInteger(value) || value < field.min || value > field.max;
      })) throw new Error('Ungueltige Einstellungsantwort.');
      return data;
    }

    acceptSettings(data) {
      this.validateSettings(data);
      for (const [key] of this.fieldDraft) if (!same(data.settings[key], this.fieldBase.get(key))) this.settingsConflicts.add(key);
      this.settings = data;
      for (const field of FIELDS) if (!this.fieldDraft.has(field.key)) this.writeField(field.key, data.settings[field.key]);
      this.paintFields(); this.updateButtons();
    }

    paintFields() {
      for (const [key, view] of this.fieldViews) {
        const mod = this.snapshot?.mods.find(mod => mod.id === view.field.mod);
        const effective = this.settings?.effective?.[key]; const unit = view.field.unit ? ` ${view.field.unit}` : '';
        view.meta.textContent = `Gespeichert: ${display(this.settings?.settings[key])}${unit} | Standard: ${display(this.settings?.defaults[key])}${unit} | Wirksam: ${effective !== undefined ? display(effective) + unit : mod?.effective === false ? 'Native Einstellung (Mod aus)' : 'Nicht separat gemeldet'}`
          + (this.fieldDraft.has(key) ? ' | Ungespeicherter Entwurf' : '') + (this.settingsConflicts.has(key) ? ' | Serverwert geaendert' : '');
        for (const input of view.controls) input.disabled = !this.settings || this.settingsBusy || Boolean(this.settingsError.textContent);
        view.reset.disabled = !this.settings || this.settingsBusy || this.settings?.defaults[key] === undefined || Boolean(this.settingsError.textContent);
      }
    }

    discardSettings(id) {
      for (const field of FIELDS.filter(field => field.mod === id)) {
        this.fieldDraft.delete(field.key); this.fieldBase.delete(field.key); this.settingsConflicts.delete(field.key);
        this.writeField(field.key, this.settings?.settings[field.key]);
      }
      this.forms.get(id).message.textContent = 'Entwurf verworfen.'; this.paintFields(); this.updateButtons();
    }

    updateButtons() {
      this.save.disabled = !this.snapshot || !this.draft.size || this.modsBusy || this.modConflict || Boolean(this.modsError.textContent);
      this.discard.disabled = !this.draft.size || this.modsBusy;
      this.review.hidden = !this.modConflict; this.review.disabled = this.modsBusy || Boolean(this.modsError.textContent);
      this.count.textContent = `${this.draft.size} Mod-Schalter geaendert`;
      this.footer.hidden = !this.draft.size && !this.message.textContent && !this.modConflict;
      for (const [id, form] of this.forms) {
        const fields = FIELDS.filter(field => field.mod === id);
        const dirty = fields.some(field => this.fieldDraft.has(field.key));
        const conflict = fields.some(field => this.settingsConflicts.has(field.key));
        form.save.disabled = !this.settings || !dirty || this.settingsBusy || conflict || Boolean(this.settingsError.textContent);
        form.discard.disabled = !dirty || this.settingsBusy;
        form.review.hidden = !conflict; form.review.disabled = !this.settings || this.settingsBusy || Boolean(this.settingsError.textContent);
      }
    }

    filter() {
      const query = this.search.value.trim().toLocaleLowerCase(); let visible = 0;
      for (const view of this.views.values()) {
        const matches = !query || view.root.textContent.toLocaleLowerCase().includes(query);
        view.root.hidden = !matches; if (matches) visible++;
      }
      this.noResults.hidden = !query || visible > 0;
    }

    async request(url, options = {}) {
      const controller = new AbortController(); this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) {
          const message = response.status === 401 ? 'Sitzung abgelaufen. Bitte erneut anmelden.' : response.status === 403 ? 'Besitzerberechtigung oder neue Anmeldung erforderlich.'
            : typeof data?.error === 'string' ? data.error : data?.error?.message || `HTTP ${response.status}`;
          throw Object.assign(new Error(message), { status: response.status });
        }
        return data;
      } finally { clearTimeout(timer); this.controllers.delete(controller); }
    }

    async csrf() {
      const me = await this.request('/api/me');
      if (!me?.csrfToken) throw new Error('Sitzung abgelaufen. Bitte erneut anmelden.');
      return { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken };
    }

    async loadMods(force = false) {
      if (this.modsBusy && !force) return;
      const sequence = this.sequences.mods = (this.sequences.mods || 0) + 1;
      try {
        const data = await this.request('/api/vf-custom/mods');
        if (!this.isConnected || sequence !== this.sequences.mods) return;
        this.validateMods(data); this.modsError.textContent = ''; this.acceptMods(data);
      } catch (error) {
        if (this.isConnected && sequence === this.sequences.mods) this.modsError.textContent = `Mod-Status nicht verfuegbar: ${error.message}`;
      } finally { this.updateButtons(); }
    }

    async loadSettings() {
      if (this.settingsBusy) return;
      const sequence = this.sequences.settings = (this.sequences.settings || 0) + 1;
      try {
        const data = await this.request('/api/vf-custom/settings');
        if (!this.isConnected || sequence !== this.sequences.settings) return;
        this.acceptSettings(data); this.settingsError.textContent = ''; this.paintFields();
      } catch (error) {
        if (this.isConnected && sequence === this.sequences.settings) this.settingsError.textContent = `Einstellungen nicht verfuegbar: ${error.message}`;
      } finally { this.paintFields(); this.updateButtons(); }
    }

    async loadStatus() {
      const sequence = this.sequences.status = (this.sequences.status || 0) + 1;
      const box = document.getElementById('vfc-status'); if (!box) return;
      try {
        const data = await this.request('/api/vf-custom/status');
        if (!this.isConnected || sequence !== this.sequences.status) return;
        if (!data || typeof data !== 'object') throw new Error('Ungueltige Statusantwort.');
        this.status = data;
        const table = element('table', 'vfc-table'); table.append(element('caption', '', 'Installation und Laufzeitdiagnose'));
        const head = element('tr');
        for (const label of ['Pruefung', 'Phase', 'Ergebnis']) head.append(element('th', '', label, { scope: 'col' }));
        const thead = element('thead'); thead.append(head); table.append(thead);
        const body = element('tbody');
        for (const [phase, rows] of [['Build', data.build?.report], ['Laufzeit', data.runtime]]) {
          for (const [key, value] of Object.entries(rows || {})) {
            const row = element('tr'); row.append(element('th', '', key, { scope: 'row' }), element('td', '', phase),
              element('td', '', value === 'ok' ? phase === 'Build' ? 'Installiert' : 'Hook registriert' : display(value))); body.append(row);
          }
        }
        table.append(body); box.replaceChildren(table);
        if (data.boost) box.append(element('p', 'vc-muted', `Beobachteter Boost: FFmpeg ${display(data.boost.ffmpeg)} | ClipVault ${display(data.boost.clipvault)} | Home-Auftraege ${display(data.boost.pcActive)}`));
        for (const mod of this.snapshot?.mods || []) this.paintMod(mod);
      } catch (error) {
        if (this.isConnected && sequence === this.sequences.status) {
          let message = box.querySelector('[data-status-error]');
          if (!message) { message = element('p', 'vfc-message vfc-error', '', { 'data-status-error': '', role: 'status' }); box.prepend(message); }
          message.textContent = `Diagnose verzoegert: ${error.message}`;
        }
      }
    }

    async refresh() {
      if (this.refreshing) return;
      this.refreshing = true; this.refreshButton.disabled = true;
      try {
        await Promise.all([this.loadMods(), this.loadSettings(), this.loadStatus()]);
        if (this.isConnected) this.checked.textContent = `Abgerufen ${new Date().toLocaleTimeString()}`;
      } finally { this.refreshing = false; this.refreshButton.disabled = false; }
    }

    async saveMods() {
      if (!this.snapshot || !this.draft.size || this.modsBusy || this.modConflict || this.modsError.textContent) return;
      this.modsBusy = true; this.sequences.mods = (this.sequences.mods || 0) + 1;
      this.message.textContent = 'Mod-Schalter werden gespeichert.';
      const changes = Object.fromEntries(this.draft); let submitted = false;
      for (const mod of this.snapshot.mods) this.paintMod(mod);
      this.updateButtons();
      try {
        const revision = this.snapshot.revision; const headers = await this.csrf();
        submitted = true;
        const data = this.validateMods(await this.request('/api/vf-custom/mods', { method: 'PATCH', headers, body: JSON.stringify({ revision, changes }) }));
        if (!this.isConnected) return;
        if (Object.entries(changes).some(([id, value]) => data.mods.find(mod => mod.id === id)?.enabled !== value)) throw new Error('Gespeicherte Mod-Werte wurden nicht bestaetigt.');
        this.draft.clear(); this.base.clear(); this.modConflict = false; this.acceptMods(data);
        this.message.textContent = data.mods.some(mod => mod.pendingRestart) ? 'Gespeichert. Neustart erforderlich; der wirksame Zustand bleibt bis dahin bestehen.' : 'Mod-Schalter gespeichert.';
      } catch (error) {
        if (!this.isConnected) return;
        if (error.status === 409) {
          this.modConflict = true; await this.loadMods(true);
          this.message.textContent = 'Serverwerte wurden geaendert. Entwurf pruefen und bewusst behalten oder verwerfen.';
        } else if (submitted && !error.status) {
          this.modConflict = true;
          await this.loadMods(true);
          this.message.textContent = `Speicherantwort unbekannt. Gespeicherte Werte pruefen: ${error.message}`;
        } else this.message.textContent = `Nicht gespeichert: ${error.message}`;
      } finally {
        this.modsBusy = false;
        for (const mod of this.snapshot?.mods || []) this.paintMod(mod);
        this.updateButtons();
      }
    }

    async saveSettings(id) {
      const form = this.forms.get(id);
      if (!form || !this.settings || this.settingsBusy || this.settingsError.textContent) return;
      const fields = FIELDS.filter(field => field.mod === id && this.fieldDraft.has(field.key));
      if (!fields.length || !form.node.reportValidity()) return;
      const candidate = { ...this.settings.settings, ...Object.fromEntries(this.fieldDraft) };
      if (id === 'surplusRetry' && candidate.surplusRetryMinSec > candidate.surplusRetryMaxSec) {
        form.message.textContent = 'Minimum darf nicht groesser als Maximum sein.'; return;
      }
      if (fields.some(field => field.type === 'efforts' && !candidate[field.key].length)) {
        form.message.textContent = 'Mindestens ein Effort-Schritt ist erforderlich.'; return;
      }
      this.settingsBusy = true; this.sequences.settings = (this.sequences.settings || 0) + 1;
      form.message.textContent = 'Einstellungen werden gespeichert.'; this.paintFields(); this.updateButtons();
      let submitted = false;
      try {
        // The legacy API has no CAS; preflight detects existing conflicts but cannot close its write race.
        const latest = await this.request('/api/vf-custom/settings'); this.acceptSettings(latest);
        if (fields.some(field => this.settingsConflicts.has(field.key))) {
          form.message.textContent = 'Serverwert geaendert. Entwurf pruefen und bewusst behalten oder verwerfen.'; return;
        }
        const patch = Object.fromEntries(fields.map(field => [field.key, this.fieldDraft.get(field.key)]));
        const headers = await this.csrf();
        submitted = true;
        const data = this.validateSettings(await this.request('/api/vf-custom/settings', { method: 'PATCH', headers, body: JSON.stringify(patch) }));
        if (!this.isConnected) return;
        if (fields.some(field => !same(data?.settings?.[field.key], patch[field.key]))) throw new Error('Gespeicherte Werte wurden nicht bestaetigt.');
        for (const field of fields) { this.fieldDraft.delete(field.key); this.fieldBase.delete(field.key); this.settingsConflicts.delete(field.key); }
        this.acceptSettings(data); form.message.textContent = 'Gespeichert. Live-Einstellungen uebernommen.';
      } catch (error) {
        if (this.isConnected) {
          if (submitted && !error.status) {
            for (const field of fields) this.settingsConflicts.add(field.key);
            form.message.textContent = `Speicherantwort unbekannt. Gespeicherte Werte aktualisieren und pruefen: ${error.message}`;
          } else form.message.textContent = `Nicht gespeichert: ${error.message}`;
        }
      } finally { this.settingsBusy = false; this.paintFields(); this.updateButtons(); }
    }
  }
  if (!customElements.get('vf-mod-settings')) customElements.define('vf-mod-settings', ModSettings);
  const host = document.querySelector('[data-vfc-editor]') || document.getElementById('vfc-mods');
  if (host && !host.querySelector('vf-mod-settings')) host.append(document.createElement('vf-mod-settings'));
})();
