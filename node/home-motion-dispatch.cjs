'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const {AsyncLocalStorage} = require('node:async_hooks');
const STAGING_MB = 1024, FLOOR_MB = 4096, MAX_RECOVERING = 2;
const recovery = new AsyncLocalStorage();

// Only reviewed render-only callbacks. Validation, probes and unknown callbacks
// must obtain native admission before running any browser or FFmpeg process.
const DIRECT = new Set(['()=>A.render(D)', '()=>c.render({...d,targetPath:t,workDir:a,timeoutMs:Number(n.timeoutMs)||1200*1e3})']);
const OPAQUE = 'async()=>{if(l5()){await fl(i,Math.max(Number(o)||.1,.1),{fps:Dxe});return}await __vfMotion.render(t.render.bind(t),{jobId:r,licensedJobId:RU(),getScope:()=>fhe.getStore(),lane:mF("frameshift"),checkAbort:()=>jp.get(r)?.checkAbort?.(),isAborted:()=>e.isJobAborted(r),outerSignal:Xl(),duration:o},{compositionHtml:Pxe(n.html,o),assets:n.assets,fps:Dxe,resolution:zjt,targetPath:i,workDir:a,timeoutMs:Y$a,renderOnlyHtml:xFn(l,{pacing:c})+(s?f6n({fps:Dxe}):"")||void 0,...u?.workers?{workers:u.workers}:{},...u?.quality?{quality:u.quality}:{}})}';
function renderOnly(callback, mock = true) {
  const source = String(callback);
  const direct = ['()=>N.render($)', '()=>d.render({...h,targetPath:t,workDir:s,timeoutMs:Number(n.timeoutMs)||1200*1e3})'];
  const opaque = 'async()=>{if(j3()){await _c(i,Math.max(Number(o)||.1,.1),{fps:v_e});return}await __vfMotion.render(t.render.bind(t),{jobId:r,licensedJobId:w8(),getScope:()=>S0e.getStore(),lane:YL("frameshift"),checkAbort:()=>af.get(r)?.checkAbort?.(),isAborted:()=>e.isJobAborted(r),outerSignal:cl(),duration:o},{compositionHtml:w_e(n.html,o),assets:n.assets,fps:v_e,resolution:fWt,targetPath:i,workDir:s,timeoutMs:PWs,renderOnlyHtml:eBn(n.html)+mJe(c,{pacing:l})+(a?w7n({fps:v_e}):"")||void 0,...u?.workers?{workers:u.workers}:{},...u?.quality?{quality:u.quality}:{}})}';
  return DIRECT.has(source) || direct.includes(source) || (!mock && (source === OPAQUE || source === opaque));
}
function availableMb() {
  try { return Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo','utf8'))?.[1] || 0)/1024; }
  catch { return 0; }
}
function createQueue({getState,getCapacity,claim,isAborted=()=>false,available=availableMb}) {
  const scopes = new Map();
  let draining=false,admitted=0,completed=0,failed=0;
  const owned=s=>s?.kind==='motion-home' && scopes.get(s.nonce)===s;
  const homeCount=()=>[...scopes.values()].filter(s=>s.phase==='home').length;
  const recovering=()=>[...scopes.values()].filter(s=>s.phase!=='home').length;
  const eligible=w=>w.resourceKey==='frameshift' && ['motion-home','motion-candidate'].includes(w.homeKind)
    && !isAborted(w.jobId);
  const cap=()=>Math.max(0,Math.min(8,Number(getCapacity())||0));
  const q={
    valid:owned,
    drain(){
      if(draining)return;draining=true;
      try {
        while(homeCount()<cap() && scopes.size<cap()+MAX_RECOVERING) {
          if(available()-(scopes.size+1)*STAGING_MB<FLOOR_MB)break;
          const candidates=[...scopes.values()].some(s=>s.candidate);
          const w=getState().waiters.filter(eligible).filter(w=>w.homeKind!=='motion-candidate'||!candidates)
            .sort((a,b)=>a.priority<b.priority?-1:a.priority>b.priority?1:a.seq-b.seq)[0];
          if(!w)break;
          const s={kind:'motion-home',nonce:crypto.randomUUID(),jobId:w.jobId,resourceKey:'frameshift',
            opKey:w.opKey,quality:w.quality,seq:w.seq,phase:'home',candidate:w.homeKind==='motion-candidate',at:Date.now()};
          scopes.set(s.nonce,s);
          try { claim(w,s);admitted++; } catch(e) { scopes.delete(s.nonce);throw e; }
        }
      } finally {draining=false;}
    },
    release(s,success){if(owned(s)){scopes.delete(s.nonce);success?completed++:failed++;}},
    serverView(fn){
      const state=getState(),active=state.activeTotal,resources=new Map(state.activeByResource),jobs=new Map(state.activeByJob);
      state.activeTotal=Math.max(0,active-scopes.size);
      for(const s of scopes.values()){
        state.activeByResource.set('frameshift',Math.max(0,(state.activeByResource.get('frameshift')||0)-1));
        const count=(state.activeByJob.get(s.jobId)||0)-1;
        count>0?state.activeByJob.set(s.jobId,count):state.activeByJob.delete(s.jobId);
      }
      try{return fn();}finally{
        state.activeTotal=active;
        state.activeByResource.clear();for(const entry of resources)state.activeByResource.set(...entry);
        state.activeByJob.clear();for(const entry of jobs)state.activeByJob.set(...entry);
      }
    },
    stats(){return {capacity:cap(),active:scopes.size,homeActive:homeCount(),recovering:recovering(),
      queued:getState().waiters.filter(eligible).length,admitted,completed,failed,
      stagingMb:scopes.size*STAGING_MB,nativeRecovered:q.nativeRecovered||0,
      candidates:[...scopes.values()].filter(s=>s.candidate).length,checkedAt:new Date().toISOString()};},
  };
  return q;
}
function attachExecution(q,{getContext,runIndependent,runNative,isAborted=()=>false,isMock=()=>true}) {
  const current=()=>getContext()?.leases?.get('render');
  let nativeRunning=0;
  q.ownsCurrent=()=>q.valid(current()?.boosted) && !recovery.getStore();
  q.native=async fn=>{
    const lease=current(),s=lease?.boosted;
    if(!q.valid(s)||recovery.getStore())return fn();
    if(s.recovering)throw Error('Concurrent Home Motion native recovery rejected');
    s.recovering=true;s.phase='native-wait';
    const controller=new AbortController(),signals=[controller.signal,lease.signal,AbortSignal.timeout(900000)].filter(Boolean);
    const signal=AbortSignal.any(signals);
    const watch=setInterval(()=>{if(isAborted(s.jobId)||lease.released)controller.abort(Error('Motion scope ended'));},1000);watch.unref?.();
    const check=()=>{
      signal.throwIfAborted();
      if(isAborted(s.jobId)||lease.released||!q.valid(s))throw Error('Motion scope ended');
    };
    let acquired=false;
    try {
      check();
      while(nativeRunning>=MAX_RECOVERING){
        await require('node:timers/promises').setTimeout(100,undefined,{signal});check();
      }
      nativeRunning++;acquired=true;s.phase='native';
      s.nativePromise=runIndependent(()=>recovery.run(true,()=>runNative(s.jobId,()=>{check();return fn();},signal,s)));
      const result=await s.nativePromise;q.nativeRecovered=(q.nativeRecovered||0)+1;return result;
    }finally{clearInterval(watch);if(acquired)nativeRunning--;delete s.nativePromise;delete s.recovering;}
  };
  q.runCallback=callback=>{
    const s=current()?.boosted;
    if(!q.valid(s))throw Error('Home Motion scope missing');
    if(renderOnly(callback,isMock())){s.candidate=false;return callback();}
    return q.native(callback);
  };
  return q;
}
function wrapEstimate(original){
  return function(request={}){const result=original.call(this,request);return request.resourceKey==='motionHome'?{...result,mb:STAGING_MB}:result;};
}
function guardRoute(route,queue){
  const call=route.call,guarded=new WeakMap();
  route.call=function(name,original,self,args){
    if(name==='render'||name==='runRender'){
      if(!guarded.has(original)){
        const native=original;
        guarded.set(original,function(...values){return queue.native(()=>Reflect.apply(native,this,values));});
      }
      original=guarded.get(original);
    }
    return call.call(this,name,original,self,args);
  };
}
function install(deps){
  if(globalThis.__vfHomeMotionQueue)return globalThis.__vfHomeMotionQueue;
  const {scheduler,getState,getContext,claim,getAdmission,setAdmission,getRelease,setRelease,
    getSlotMeasurer,setSlotMeasurer,getEstimate,setEstimate,runIndependent,getSettings,isMock,remote}=deps;
  for(const key of ['getState','getContext','claim','getAdmission','setAdmission','getRelease','setRelease',
    'getSlotMeasurer','setSlotMeasurer','getEstimate','setEstimate','runIndependent','getSettings','isMock'])
    if(typeof deps[key]!=='function')throw Error('Motion native binding missing: '+key);
  if(typeof getSlotMeasurer()!=='function'||typeof getEstimate()!=='function'||typeof scheduler?.run!=='function'
    ||typeof globalThis.__vfFrameshiftRoute?.call!=='function')throw Error('Motion scheduler not ready');
  let queue;
  const capacity=()=>{
    try{
      const cfg=getSettings(),health=globalThis.__vfHomeCapabilities,route=globalThis.__vfFrameshiftRoute;
      if(queue?.enabled===false||!cfg?.homeMotion||!route||!health?.ready||Date.now()-health.checkedAt>20000)return 0;
      const limit=Number.isSafeInteger(cfg.motionSlots)&&cfg.motionSlots>=1&&cfg.motionSlots<=8?cfg.motionSlots:2;
      const external=Math.max(0,(route.stats?.active||0)-(queue?.statsHomeCount?.()||0));
      return Math.max(0,limit-external);
    }catch{return 0;}
  };
  // Avoid recursing through stats()->capacity() for the external-occupancy estimate.
  let homeCount=0;
  const q=createQueue({getState,getCapacity:()=>capacity(),isAborted:id=>scheduler.isJobAborted(id),
    claim(w,s){const resolve=w.resolve;w.resolve=lease=>resolve({...lease,cooldownProbe:false,homeScope:s});claim(w);}});
  queue=q;q.enabled=true;q.version=1;q.statsHomeCount=()=>homeCount;
  attachExecution(q,{getContext,runIndependent,isMock,isAborted:id=>scheduler.isJobAborted(id),
    runNative:(jobId,fn,signal,s)=>scheduler.run(jobId,'frameshift',fn,{signal,homeKind:'motion-native-recovery',
      segmentType:s.opKey,quality:s.quality,operation:'home-motion-native-recovery'})});
  const admission=getAdmission();
  setAdmission(function(lane,...args){return lane==='render'?q.serverView(()=>admission.call(this,lane,...args)):admission.call(this,lane,...args);});
  const release=getRelease();
  setRelease(function(lane,jobId,success,resource,boosted){
    if(lane==='render'&&q.valid(boosted)){q.release(boosted,success);boosted=false;}
    // The parent Home lease owns native demand accounting, not its recovery lease.
    if(lane==='render'&&recovery.getStore())success=false;
    return release.call(this,lane,jobId,success,resource,boosted);
  });
  setEstimate(wrapEstimate(getEstimate()));
  const sampler=getSlotMeasurer();
  setSlotMeasurer(function(request){
    if(request.lane!=='render'||request.resourceKey!=='ffmpegHome')return sampler.call(this,request);
    let sample;
    try{sample=sampler.call(this,{...request,resourceKey:'motionHome'});}catch{q.samplingErrors=(q.samplingErrors||0)+1;}
    return {run:callback=>sample?.run?sample.run(()=>q.runCallback(callback)):q.runCallback(callback),finish:(...args)=>sample?.finish?.(...args)};
  });
  const run=scheduler.run;
  const wrapped=function(jobId,resource,callback,options){
    if(resource==='frameshift'&&options?.homeKind!=='motion-native-recovery')
      options={...options,homeKind:renderOnly(callback,isMock())?'motion-home':'motion-native'};
    return run.call(this,jobId,resource,callback,options);
  };
  Object.assign(wrapped,run);wrapped.__vfHomeMotion=true;scheduler.run=wrapped;
  require('./home-motion-recovery-order.cjs').install({queue:q,scheduler,getState,getContext});
  const stats=scheduler.stats;
  scheduler.stats=function(...args){const result=q.serverView(()=>stats.apply(this,args));if(result.render)result.render.homeMotion=q.stats();return result;};
  let migrated=0;
  for(const w of getState().waiters)if(w.resourceKey==='frameshift'&&!w.homeKind){w.homeKind='motion-candidate';migrated++;}
  q.migrated=migrated;
  const tick=()=>{try{homeCount=q.stats().homeActive;q.drain();homeCount=q.stats().homeActive;}catch(e){console.warn('[home-motion] dispatch deferred',e?.name);}};
  q.timer=setInterval(tick,1000);q.timer.unref?.();
  guardRoute(globalThis.__vfFrameshiftRoute,q);
  if(remote){const begin=remote.begin;remote.begin=function(resource='frameshift'){
    return resource==='frameshift'&&q.ownsCurrent()?()=>{}:begin.call(this,resource);
  };}
  globalThis.__vfHomeMotionQueue=q;tick();return q;
}
module.exports={createQueue,attachExecution,renderOnly,install,wrapEstimate,guardRoute,STAGING_MB,FLOOR_MB,DIRECT,OPAQUE};
