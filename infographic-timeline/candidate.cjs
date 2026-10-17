// STAGING ONLY. Pure source transforms; never imports or writes the application.
function replaceOnce(source, before, after) {
  if(source.split(before).length!==2) throw new Error('Native source anchor drift');
  return source.replace(before,after);
}
exports.patchTimeline=function(source) {
  source=replaceOnce(source,
    'if (prev != null) at = Math.max(at, prev + Math.round(fps * 0.25));',
    'if (own == null && prev != null) at = Math.max(at, prev + Math.round(fps * 0.25));');
  source=replaceOnce(source,
    '  if (frame <= arrivals[0]) return 0;\n  for (let i = 1; i < arrivals.length; i++) {\n    if (frame > arrivals[i]) continue;\n    const travel = Math.max(1, Math.min(arrivals[i] - arrivals[i - 1], Math.round(fps * 0.6)));\n    const k = prog(frame, arrivals[i] - travel, travel, ease.inOutSine);\n    return pos(i - 1) + (pos(i) - pos(i - 1)) * k;\n  }\n  return 1;',
    '  const order = arrivals.map((at, i) => ({ at, i })).sort((a, b) => a.at - b.at || a.i - b.i);\n  if (frame <= order[0].at) return pos(order[0].i);\n  for (let j = 1; j < order.length; j++) {\n    const prev = order[j - 1], next = order[j];\n    if (frame > next.at) continue;\n    const travel = Math.max(1, Math.min(next.at - prev.at, Math.round(fps * 0.6)));\n    const k = prog(frame, next.at - travel, travel, ease.inOutSine);\n    return pos(prev.i) + (pos(next.i) - pos(prev.i)) * k;\n  }\n  return pos(order[order.length - 1].i);');
  return replaceOnce(source,'  if (frame <= order[0].at) return pos(order[0].i);','  if (arrivals.length === 1) return frame <= arrivals[0] ? 0 : 1;\n  if (frame <= order[0].at) {\n    const travel = Math.max(1, Math.min(order[0].at, Math.round(fps * 0.6)));\n    return pos(order[0].i) * prog(frame, order[0].at - travel, travel, ease.inOutSine);\n  }');
};
exports.patchCueProducer=function(source) {
  const start=source.indexOf('function Vkn('), end=source.indexOf('function Ykn(',start);
  if(start<0 || end<0) throw new Error('Cue function missing');
  let fn=source.slice(start,end);
  fn=replaceOnce(fn,'d=a,p=u.map(f=>{','p=u.map(f=>{');
  fn=replaceOnce(fn,'value:h,from:d,to:s','value:h,from:a,to:s');
  fn=replaceOnce(fn,'phrase:f.title,from:d,to:s','phrase:f.title,from:a,to:s');
  fn=replaceOnce(fn,'return b?(d=b.start+.05,l(b.start)):null','return b?l(b.start):null');
  return source.slice(0,start)+fn+source.slice(end);
};
