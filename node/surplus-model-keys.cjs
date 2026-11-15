'use strict';
// DeepSeek V4.1 Flash runs on its own Surplus key (user request 2026-11-05). Every DeepSeek attempt,
// including the native same-model retries and the stream->blocking retry, goes through that key.
// v2: after the DeepSeek leg is exhausted, one more DeepSeek leg (all its retries) runs on the
// configured Surplus key, then the existing Luna fallback, also on the configured key.
// The key lives in a private runtime file (0600), never in source or notes. Missing/invalid file =
// configured key everywhere.
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');

const VERSION = 'surplus-model-keys-v2';
const FILE = '/data/runtime/surplus-deepseek-key';
const MODELS = new Set(['deepseek-v4.1-flash']);
const KEY = /^inf_[A-Za-z0-9]{16,128}$/;
const CONFIGURED = 'configured';
const keyScope = new AsyncLocalStorage();

function createKeyReader({ file = FILE, now = Date.now, read = path => fs.readFileSync(path, 'utf8') } = {}) {
  let checked = -Infinity, key = null;
  return () => {
    const at = now();
    if (at - checked < 5000 && at >= checked) return key;
    checked = at;
    try { const value = read(file).trim(); key = KEY.test(value) ? value : null; } catch { key = null; }
    return key;
  };
}

const sharedKey = createKeyReader();
const modelOf = model => String(model || '').toLowerCase().split('/').at(-1);
const isDeepSeekLeg = leg => leg?.provider === 'surplus' && MODELS.has(modelOf(leg.model));

function wrapSurplusRequest(original, { readKey = createKeyReader(), scope = keyScope } = {}) {
  if (typeof original !== 'function') throw new TypeError('original must be a function');
  if (original.__vfSurplusModelKeys === VERSION) return original;
  if (original.__vfSurplusModelKeys && typeof original.original === 'function') original = original.original;
  const stats = { version: VERSION, routed: 0, configuredRound: 0, missingKey: 0 };
  function wrapped(args) {
    if (args?.provider === 'surplus' && MODELS.has(modelOf(args.payload?.model))) {
      if (scope.getStore()?.surplusKey === CONFIGURED) { stats.configuredRound++; return Reflect.apply(original, this, arguments); }
      const key = readKey();
      if (key) { stats.routed++; return Reflect.apply(original, this, [{ ...args, apiKey: key }]); }
      stats.missingKey++;
    }
    return Reflect.apply(original, this, arguments);
  }
  wrapped.__vfSurplusModelKeys = VERSION;
  wrapped.original = original;
  wrapped.stats = stats;
  return wrapped;
}

// Native per-attempt call gis({spec,...}): a leg marked surplusKey "configured" runs in a scope that
// the request wrapper above reads, so its attempts keep the configured key.
function wrapAttempt(original, { scope = keyScope } = {}) {
  if (typeof original !== 'function') throw new TypeError('original must be a function');
  if (original.__vfSurplusAttempt === VERSION) return original;
  function wrapped(args) {
    if (args?.spec?.surplusKey === CONFIGURED) return scope.run({ surplusKey: CONFIGURED }, () => Reflect.apply(original, this, arguments));
    return Reflect.apply(original, this, arguments);
  }
  wrapped.__vfSurplusAttempt = VERSION;
  wrapped.original = original;
  return wrapped;
}

// [DeepSeek(own key), ...] -> [DeepSeek(own key), DeepSeek(configured key), ...]: the copy follows the
// last DeepSeek leg, i.e. it runs before the Luna fallback that withSurplusVisionFallback inserts there.
function withConfiguredKeyRound(chain, { hasKey = () => sharedKey() !== null } = {}) {
  if (!Array.isArray(chain) || chain.some(leg => leg?.surplusKey === CONFIGURED)) return chain;
  const legs = chain.filter(isDeepSeekLeg);
  if (!legs.length || !hasKey()) return chain;
  const last = chain.findLastIndex(isDeepSeekLeg);
  return [...chain.slice(0, last + 1), ...legs.map(leg => ({ ...leg, surplusKey: CONFIGURED })), ...chain.slice(last + 1)];
}

function wrapChainBuilder(original) {
  if (typeof original !== 'function') throw new TypeError('original must be a function');
  if (original.__vfSurplusChain === VERSION) return original;
  function wrapped(...args) { return withConfiguredKeyRound(Reflect.apply(original, this, args)); }
  wrapped.__vfSurplusChain = VERSION;
  wrapped.original = original;
  return wrapped;
}

module.exports = { wrapSurplusRequest, wrapAttempt, withConfiguredKeyRound, wrapChainBuilder, createKeyReader,
  keyScope, VERSION, FILE, MODELS };
