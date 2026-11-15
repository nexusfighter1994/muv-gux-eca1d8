'use strict';

const INSTALLED = Symbol.for('vf-custom.render-prerequisite.v1');

function isUnavailable(error) {
  const pending = [error], seen = new Set();
  for (let i = 0; i < pending.length && i < 64; i++) {
    const item = pending[i];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (item.code === 'authorization_unavailable') return true;
    if (item.cause) pending.push(item.cause);
    if (item.code === 'all_providers_failed') {
      for (const detail of (Array.isArray(item.detail?.errorDetails) ? item.detail.errorDetails.slice(0, 32) : [])) pending.push(detail);
    }
  }
  return false;
}

function install(target, { enabled = () => true } = {}) {
  for (const name of ['axn', 'nc', 'Wxo']) {
    if (typeof target[name] !== 'function') throw new TypeError('Missing native render control: ' + name);
  }
  for (const [name, disposition] of [['axn', false], ['nc', false], ['Wxo', true]]) {
    const original = target[name];
    if (original[INSTALLED]) continue;
    const wrapped = function(error, ...args) {
      if (enabled() && isUnavailable(error)) {
        // Use the native prerequisite pause path; never replace a missing permit with media.
        error.pauseRun = true;
        error.noRetry = true;
        return disposition ? 'pause_run' : true;
      }
      return original.call(this, error, ...args);
    };
    Object.defineProperty(wrapped, INSTALLED, { value: true });
    target[name] = wrapped;
  }
  return target;
}

module.exports = { install, isUnavailable };
