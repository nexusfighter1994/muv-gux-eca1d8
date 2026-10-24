'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {AsyncLocalStorage} = require('node:async_hooks');
let api = {};
try { api = require('../node/home-motion-dispatch.cjs'); } catch(e) { if(e.code !== 'MODULE_NOT_FOUND') throw e; }
function fixture() {
  assert.equal(typeof api.createQueue, 'function', 'Home Motion dispatcher missing');
  const state={activeTotal:9,activeByResource:new Map([['frameshift',9]]),activeByJob:new Map([['native',9]]),waiters:[]};
  const claimed=[];let cap=4,available=20000;
  const q=api.createQueue({getState:()=>state,getCapacity:()=>cap,available:()=>available,isAborted:id=>id==='aborted',
    claim(w,s){state.waiters.splice(state.waiters.indexOf(w),1);state.activeTotal++;state.activeByResource.set('frameshift',(state.activeByResource.get('frameshift')||0)+1);state.activeByJob.set(w.jobId,(state.activeByJob.get(w.jobId)||0)+1);claimed.push(s);}});
  return {q,state,claimed,cap:v=>cap=v,available:v=>available=v};
}
const waiter=(jobId,kind='motion-home')=>({jobId,homeKind:kind,resourceKey:'frameshift',priority:jobId,seq:0});
test('claims ordered render-only work independent of blocked native RAM and slots',()=>{
  const f=fixture();f.state.waiters.push(waiter('b'),waiter('a'),waiter('aborted'),{...waiter('map'),resourceKey:'geomap'},waiter('validation','motion-native'));
  f.q.drain();f.q.drain();assert.deepEqual(f.claimed.map(s=>s.jobId),['a','b']);
  assert.equal(f.q.serverView(()=>f.state.activeTotal),9);assert.equal(f.state.activeTotal,11);
  assert.equal(f.q.serverView(()=>f.state.activeByJob.has('a')),false);
  const scope=f.claimed[0];assert.equal(scope.seq,0,'Home scope retains original queue position');
  f.q.release(scope,true);f.q.release(scope,true);assert.equal(f.q.stats().completed,1);
});
test('offline and staging memory pressure stop NEW work without invalidating active tokens',()=>{
  const f=fixture();f.state.waiters.push(waiter('a'),waiter('b'));f.available(5500);f.q.drain();assert.equal(f.claimed.length,1);
  f.cap(0);f.q.drain();assert.equal(f.claimed.length,1);assert.equal(f.q.valid(f.claimed[0]),true);
  assert.equal(f.q.valid({...f.claimed[0]}),false,'tokens are owned object identities');
});
test('unknown old callbacks are bounded candidates, not unrestricted native work',()=>{
  const f=fixture();f.state.waiters.push(waiter('a','motion-candidate'),waiter('b','motion-candidate'));f.q.drain();assert.equal(f.claimed.length,1);
  assert.equal(api.renderOnly(()=>provider.validateComposition(options)),false);
  assert.equal(api.renderOnly(()=>provider.render(options)),false,'arbitrary unknown source is not trusted');
  assert.equal(api.renderOnly(()=>A.render(D)),true,'reviewed native direct render callback');
});
test('recovery enters original native admission exactly once, restores context and never replays callback',async()=>{
  const als=new AsyncLocalStorage();const f=fixture();f.state.waiters.push(waiter('a'));f.q.drain();
  const scope=f.claimed[0], lease={boosted:scope,resourceKey:'frameshift',released:false};
  let permit,entered=0,calls=0;
  const context={jobId:'a',lanes:new Set(['render','llm']),leases:new Map([['render',lease],['llm',{}]])};
  api.attachExecution(f.q,{getContext:()=>als.getStore(),runIndependent:fn=>{
    const c=als.getStore();const lanes=new Set(c.lanes),leases=new Map(c.leases);lanes.delete('render');leases.delete('render');return als.run({...c,lanes,leases},fn);
  },runNative:async(id,fn,signal)=>{entered++;assert.equal(als.getStore().lanes.has('render'),false);await new Promise(r=>permit=r);signal.throwIfAborted();return fn();},isAborted:()=>false});
  const p=als.run(context,()=>f.q.native(async()=>{calls++;return 42;}));
  await new Promise(r=>setImmediate(r));assert.equal(calls,0);assert.equal(entered,1);permit();assert.equal(await p,42);assert.equal(calls,1);
  assert.equal(context.leases.get('render'),lease);assert.equal(f.q.stats().nativeRecovered,1);
});
test('canceled recovery never executes its original callback',async()=>{
  const als=new AsyncLocalStorage(),f=fixture();f.state.waiters.push(waiter('a'));f.q.drain();const scope=f.claimed[0],ac=new AbortController();let calls=0;
  api.attachExecution(f.q,{getContext:()=>als.getStore(),runIndependent:fn=>fn(),isAborted:()=>false,
    runNative:async(id,fn,signal)=>{ac.abort(Error('stop'));signal.throwIfAborted();return fn();}});
  await assert.rejects(als.run({jobId:'a',leases:new Map([['render',{boosted:scope,signal:ac.signal}]])},()=>f.q.native(()=>calls++)),/stop/);assert.equal(calls,0);
});
test('abort between native admission and callback cannot start the renderer',async()=>{
  const als=new AsyncLocalStorage(),f=fixture();f.state.waiters.push(waiter('a'));f.q.drain();
  const scope=f.claimed[0],ac=new AbortController();let calls=0;
  api.attachExecution(f.q,{getContext:()=>als.getStore(),runIndependent:fn=>fn(),isAborted:()=>false,
    runNative:async(id,fn)=>{ac.abort(Error('admission race'));return fn();}});
  await assert.rejects(als.run({jobId:'a',leases:new Map([['render',{boosted:scope,signal:ac.signal}]])},()=>f.q.native(()=>calls++)),/admission race/);
  assert.equal(calls,0);
});
test('four simultaneous Home failures submit at most two counted native recoveries',async()=>{
  const als=new AsyncLocalStorage(),f=fixture();for(const id of ['a','b','c','d'])f.state.waiters.push(waiter(id));f.q.drain();
  let running=0,max=0;const releases=[];
  api.attachExecution(f.q,{getContext:()=>als.getStore(),runIndependent:fn=>fn(),isAborted:()=>false,
    runNative:async(id,fn)=>{running++;max=Math.max(max,running);await new Promise(r=>releases.push(r));try{return fn();}finally{running--;}}});
  const promises=f.claimed.map(scope=>als.run({jobId:scope.jobId,leases:new Map([['render',{boosted:scope}]])},()=>f.q.native(()=>scope.jobId)));
  await new Promise(r=>setTimeout(r,10));assert.equal(releases.length,2);assert.equal(max,2);
  releases.splice(0).forEach(r=>r());await new Promise(r=>setTimeout(r,160));releases.splice(0).forEach(r=>r());
  assert.deepEqual(await Promise.all(promises),['a','b','c','d']);assert.equal(max,2);
});

test('staging estimate applies only to Home Motion, never to native RAM requests',()=>{
  const wrapped=api.wrapEstimate(r=>({mb:r.resourceKey==='frameshift'?3000:100,learnable:false}));
  assert.equal(wrapped({resourceKey:'motionHome'}).mb,1024);
  assert.equal(wrapped({resourceKey:'frameshift'}).mb,3000);
  assert.equal(wrapped({resourceKey:'ffmpeg'}).mb,100);
});
test('two native waits do not block free Home capacity, with bounded total scopes',()=>{
  const f=fixture();f.state.waiters.push(waiter('a'),waiter('b'));f.q.drain();
  for(const s of f.claimed)s.phase='native-wait';
  for(const id of ['c','d','e','f','g','h'])f.state.waiters.push(waiter(id));
  f.q.drain();assert.equal(f.q.stats().homeActive,4);assert.equal(f.q.stats().active,6);
  for(const s of f.claimed)s.phase='native-wait';
  f.q.drain();assert.equal(f.q.stats().active,6,'recovery burst cannot grow retained work unbounded');
});
test('guard covers refusal, bypass and low-level native paths, not materialization',async()=>{
  const calls=[];const route={call:(name,original,self,args)=>Reflect.apply(original,self,args)};
  const q={native:async fn=>{calls.push('permit');return fn();}};
  api.guardRoute(route,q);
  const native=()=>{calls.push('native');return 42;};
  assert.equal(await route.call('render',native,null,[]),42);
  assert.equal(await route.call('runRender',native,null,[]),42);
  assert.equal(await route.call('materializeProject',native,null,[]),42);
  assert.deepEqual(calls,['permit','native','permit','native','native']);
});
test('recovery allowance stays bounded while old candidate waits for server RAM',async()=>{
  const f=fixture();f.state.waiters.push(waiter('a','motion-candidate'),waiter('b','motion-candidate'),waiter('c'));
  f.q.drain();assert.equal(f.claimed.length,2);f.claimed[0].phase='native';f.q.drain();assert.equal(f.claimed.length,2);
  f.cap(0);assert.equal(f.q.valid(f.claimed[0]),true);
});
test('installation keeps native gate, scopes, demand and remote counts correct',async()=>{
  const als=new AsyncLocalStorage(),state={activeTotal:0,activeByResource:new Map(),activeByJob:new Map(),waiters:[]};
  let seq=0,successes=0,nativeAllowed=false,localCalls=0,admission,release,sampler,estimate;
  const seenEstimates=[];
  const remote={begin(){throw Error('independent render must not increase native replacement capacity');}};
  const gate=()=>nativeAllowed;
  const claim=w=>{assert.ok(state.waiters.includes(w));state.waiters.splice(state.waiters.indexOf(w),1);state.activeTotal++;
    state.activeByResource.set('frameshift',(state.activeByResource.get('frameshift')||0)+1);state.activeByJob.set(w.jobId,(state.activeByJob.get(w.jobId)||0)+1);w.resolve({});};
  admission=()=>state.activeTotal===0?null:'busy';
  release=async(lane,jobId,success)=>{state.activeTotal--;state.activeByResource.set('frameshift',state.activeByResource.get('frameshift')-1);state.activeByJob.set(jobId,state.activeByJob.get(jobId)-1);if(success)successes++;};
  estimate=r=>({mb:r.resourceKey==='frameshift'?3000:10});
  sampler=request=>{seenEstimates.push(estimate(request).mb);return {run:fn=>fn(),finish(){}};};
  const scheduler={isJobAborted:()=>false,getMemoryGate:()=>gate,stats:()=>({render:{active:state.activeTotal}}),
    async run(jobId,resource,callback,options={}){
      const token=await new Promise((resolve,reject)=>state.waiters.push({jobId,resourceKey:resource,priority:jobId,seq:++seq,homeKind:options.homeKind,resolve,reject}));
      options.signal?.throwIfAborted();const lease={jobId,resourceKey:resource,boosted:token.homeScope||false,released:false,signal:options.signal};
      const sample=sampler({lane:'render',resourceKey:lease.boosted?'ffmpegHome':resource});let success=false;
      try{return await als.run({jobId,lanes:new Set(['render']),leases:new Map([['render',lease]])},async()=>{const r=await sample.run(callback);success=true;return r;});}
      finally{sample.finish();lease.released=true;await release('render',jobId,success,resource,lease.boosted);}
    }};
  const previous={q:globalThis.__vfHomeMotionQueue,r:globalThis.__vfFrameshiftRoute,h:globalThis.__vfHomeCapabilities};
  globalThis.__vfFrameshiftRoute={stats:{active:0},call:(name,fn,self,args)=>Reflect.apply(fn,self,args)};
  globalThis.__vfHomeCapabilities={ready:true,checkedAt:Date.now()};
  // Availability injection uses the factory in other tests; install reads Linux meminfo.
  const fs=require('node:fs'),read=fs.readFileSync;fs.readFileSync=function(file,...args){return file==='/proc/meminfo'?'MemAvailable: 22000000 kB\n':read.call(this,file,...args);};
  let q;
  try{
    q=api.install({scheduler,getState:()=>state,getContext:()=>als.getStore(),claim,
      getAdmission:()=>admission,setAdmission:f=>admission=f,getRelease:()=>release,setRelease:f=>release=f,
      getSlotMeasurer:()=>sampler,setSlotMeasurer:f=>sampler=f,getEstimate:()=>estimate,setEstimate:f=>estimate=f,
      isMock:()=>false,getSettings:()=>({homeMotion:true,motionSlots:4}),remote,
      runIndependent:fn=>{const c=als.getStore(),lanes=new Set(c.lanes),leases=new Map(c.leases);lanes.delete('render');leases.delete('render');return als.run({...c,lanes,leases},fn);}});
    const A={render:async()=>{const end=remote.begin('frameshift');end();return q.native(()=>{localCalls++;return 'original-output';});}},D={};
    const result=scheduler.run('job','frameshift',()=>A.render(D));q.drain();
    const later={...waiter('job','motion-native'),seq:++seq};state.waiters.push(later);
    const higher={...waiter('higher','motion-native'),priority:'aaa',seq:++seq};state.waiters.push(higher);
    await new Promise(r=>setImmediate(r));assert.equal(localCalls,0);assert.equal(scheduler.getMemoryGate(),gate);
    assert.equal(q.stats().recovering,1);assert.equal(admission('render'),null,'Home lease cannot deadlock native recovery');
    assert.equal(scheduler.stats().render.active,0,'Home parent is not a busy SERVER slot');
    assert.equal(state.activeTotal,1,'display must not mutate native lease accounting');
    assert.equal(scheduler.stats().render.homeMotion.active,1);
    const recovery=state.waiters.find(w=>w.homeKind==='motion-native-recovery');
    assert.ok(recovery);assert.equal(recovery.seq,1,'recovery must retain the original parent queue position');
    assert.equal(later.seq,2,'ordinary waiting work must not be renumbered');
    const ordered=[...state.waiters].sort((a,b)=>a.priority<b.priority?-1:a.priority>b.priority?1:a.seq-b.seq);
    assert.deepEqual(ordered,[higher,recovery,later],'recovery must not bypass a higher-priority job');
    q.drain();assert.equal(state.waiters.length,3,'recovery must not return to Home');
    nativeAllowed=true;claim(recovery);assert.equal(await result,'original-output');
    assert.equal(localCalls,1);assert.equal(successes,1,'native demand counted only once');assert.equal(state.activeTotal,0);
    assert.deepEqual(seenEstimates,[1024,3000]);assert.equal(q.stats().active,0);
  }finally{
    clearInterval(q?.timer);fs.readFileSync=read;
    if(previous.q)globalThis.__vfHomeMotionQueue=previous.q;else delete globalThis.__vfHomeMotionQueue;
    if(previous.r)globalThis.__vfFrameshiftRoute=previous.r;else delete globalThis.__vfFrameshiftRoute;
    if(previous.h)globalThis.__vfHomeCapabilities=previous.h;else delete globalThis.__vfHomeCapabilities;
  }
});
