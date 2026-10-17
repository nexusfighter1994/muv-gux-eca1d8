'use strict';
const { createSafeJoin, entries } = require('./bounded-safe-join.cjs');
const { validateCopy } = require('./validate-copy.cjs');

function createLongAssembly({ probe, run }) {
  return {
    createJoin: () => createSafeJoin({ probe, run, validateCopy }),
    async validate(paths, target, options = {}) {
      const inputs = [];
      for (const file of [...paths, target]) {
        options.signal?.throwIfAborted();
        const result = await probe(['-v', 'error', '-show_entries', entries, '-of', 'json', file],
          { signal: options.signal, timeoutMs: 60000 });
        if (result?.code && result.code !== 0) return false;
        inputs.push(JSON.parse(typeof result === 'string' ? result : result.stdout));
      }
      const output = inputs.pop(), proof = validateCopy(inputs, output);
      if (proof.ok) console.info('[vf-custom] Long assembly copy integrity verified: ' + JSON.stringify(proof.details));
      return proof.ok;
    },
  };
}
module.exports = { createLongAssembly };
