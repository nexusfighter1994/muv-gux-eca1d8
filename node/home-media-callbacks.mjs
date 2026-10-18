// Exact 2026-10-18 native callbacks. Opaque overlay wrappers also serve probes;
// these are admission candidates only: argv MUST qualify before any offload.
const CALLBACKS = new Map([
  ['()=>x(D,{...$,signal:l})', 'composite-overlay'],
  ['()=>i(T,{signal:p})', 'composite-overlay'],
  ['()=>it(["-y","-i",j,"-filter:v","hflip","-c:v","libx264","-preset","fast","-crf","18","-an",Y])', 'video-mirror'],
]);

export function classifyHomeMediaCallback(callback) {
  const source = typeof callback === 'function' ? Function.prototype.toString.call(callback)
    : typeof callback === 'string' ? callback : null;
  return CALLBACKS.get(source) ?? null;
}
