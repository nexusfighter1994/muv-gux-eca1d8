const MINIMUM_MS = 6 * 60 * 60 * 1000;
const MULTIPLIER = 4;

export function extendSourcingBudget(original) {
  if (typeof original !== 'function') throw new TypeError('A native sourcing budget function is required');
  if (original.vfExtendedSourcingBudget) return original;
  function budget(...args) {
    return Math.max(MINIMUM_MS, MULTIPLIER * original.apply(this, args));
  }
  Object.defineProperty(budget, 'vfExtendedSourcingBudget', { value: true });
  return budget;
}
