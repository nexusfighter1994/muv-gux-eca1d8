let configuration=null;
export function configureMotion(value){configuration=value;}
export function getMotionConfiguration(){return configuration;}
// With the package-level Frameshift route installed, every render reaches Home through it;
// these older call-site hooks must not offer the same render a second time.
const routed=()=>Boolean(globalThis.__vfFrameshiftRoute);
export async function render(native,context,options){
  if(routed())return native(options);
  const c=configuration;
  if(!c||c.getSettings()?.homeMotion!==true)return native(options);
  const scope=context.getScope(),lease=scope?.leases?.get(context.lane);
  const signal=lease?.signal??context.outerSignal;
  const valid=()=>{
    context.checkAbort();
    return context.licensedJobId===context.jobId&&scope?.jobId===context.jobId
      &&scope?.lanes?.has(context.lane)&&context.getScope()?.leases?.get(context.lane)===lease
      &&lease?.resourceKey==='frameshift'&&!lease.released&&!lease.parked&&!context.isAborted();
  };
  if(!signal||!valid())return native(options);
  const {createMotionHook}=await import('./hook.mjs');
  return createMotionHook(native,{...c,token:c.getToken(),permitted:valid})(options,{signal,duration:context.duration});
}

function overlayDuration(html){
  if(typeof html!=='string'||Buffer.byteLength(html)>2*1024*1024)return null;
  // Recognize only the original Za overlay header, not arbitrary HTML or script text.
  const root=/^<!doctype html>\s*<html>\s*<head>\s*<meta charset="utf-8">\s*<style>[^<]*<\/style>\s*<\/head>\s*<body>\s*<div id="root" data-composition-id="main" data-start="0" data-duration="([0-9]+(?:\.[0-9]+)?)" data-width="1920" data-height="1080">/.exec(html);
  if(!root||(html.match(/\bdata-composition-id\s*=/gi)||[]).length!==1)return null;
  const duration=Number(root[1]);
  return Number.isFinite(duration)&&duration>0&&duration<=15?duration:null;
}

export async function renderOverlay(native,context,options){
  if(routed())return native(options);
  const c=configuration;
  if(!c||c.getSettings()?.homeMotion!==true)return native(options);
  if(!context||!['getScope','getLicensedJobId','checkAbort','isAborted']
    .every(key=>typeof context[key]==='function'))return native(options);
  const scope=context.getScope(),lease=scope?.leases?.get(context.lane);
  const signals=[lease?.signal,context.outerSignal,options.signal].filter(Boolean);
  const signal=signals.length?AbortSignal.any(signals):null;
  const valid=()=>{
    signal?.throwIfAborted();
    context.checkAbort();
    if(context.isAborted())throw Object.assign(Error('native render aborted'),{noFallback:true});
    return configuration===c&&c.getSettings()?.homeMotion===true
      &&context.kind==='frameshift-alpha-v1'&&context.lane==='render'
      &&typeof context.jobId==='string'&&!!context.jobId
      &&context.licensedJobId===context.jobId&&context.getLicensedJobId()===context.jobId
      &&scope?.jobId===context.jobId&&context.getScope()===scope
      &&scope?.lanes?.has(context.lane)&&scope?.leases?.get(context.lane)===lease
      &&lease?.jobId===context.jobId&&lease?.lane===context.lane
      &&lease?.resourceKey==='frameshift'&&lease.released===false&&lease.parked===false;
  };
  if(!valid()||!signal)return native(options);
  const duration=overlayDuration(options.compositionHtml);
  if(duration===null)return native(options);
  const {createAlphaHook}=await import('./alpha-hook.mjs');
  return createAlphaHook(native,{...c,token:c.getToken(),permitted:valid})
    (options,{kind:context.kind,duration,signal});
}
