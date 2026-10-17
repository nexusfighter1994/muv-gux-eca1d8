export function chunkStallMs(value) {
  const configured = Number(value);
  return Math.max(18000000, Number.isFinite(configured) ? Math.floor(configured) : 0);
}
