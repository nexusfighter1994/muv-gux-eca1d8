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
  // 21.11.: 256 MB per scope (was 1024): 4400-256 >= 4096 admits one, 4400-512 < 4096 stops the second.
  const f=fixture();f.state.waiters.push(waiter('a'),waiter('b'));f.available(4400);f.q.drain();assert.equal(f.claimed.length,1);
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
  assert.equal(wrapped({resourceKey:'motionHome'}).mb,256); // vf-custom:motion-staging-256-v1
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
  globalThis.__vfFrameshiftRoute={stats:{active:4,homeInFlight:0},call:(name,fn,self,args)=>Reflect.apply(fn,self,args)};
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
    assert.equal(q.stats().capacity,4,'server-only route fallbacks must not occupy Home slots');
    globalThis.__vfFrameshiftRoute.stats.homeInFlight=2;
    assert.equal(q.stats().capacity,2,'real external Home targets still consume capacity');
    globalThis.__vfFrameshiftRoute.stats.homeInFlight=0;
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
    assert.deepEqual(seenEstimates,[256,3000]);assert.equal(q.stats().active,0);
  }finally{
    clearInterval(q?.timer);fs.readFileSync=read;
    if(previous.q)globalThis.__vfHomeMotionQueue=previous.q;else delete globalThis.__vfHomeMotionQueue;
    if(previous.r)globalThis.__vfFrameshiftRoute=previous.r;else delete globalThis.__vfFrameshiftRoute;
    if(previous.h)globalThis.__vfHomeCapabilities=previous.h;else delete globalThis.__vfHomeCapabilities;
  }
});

// 2026-11-21: the admission guard charged 1024 MB of server RAM per Home scope; 7 scopes needed 12.3 GB free.
test('admission: 256 MB per scope by default admits Home work at 9-13 GB free; the knob can tighten it again',()=>{
  const os=require('node:os'),path=require('node:path'),fsx=require('node:fs');
  const file=path.join(os.tmpdir(),`vf-hmd-${process.pid}-${Math.random()}.json`);
  const state={activeTotal:0,activeByResource:new Map(),activeByJob:new Map(),waiters:[]};
  const claimed=[];let t=0;
  const make=()=>api.createQueue({getState:()=>state,getCapacity:()=>9,available:()=>10000,admission:api.createAdmissionReader(file,fsx,5000,()=>t),
    claim(w,s){state.waiters.splice(state.waiters.indexOf(w),1);claimed.push(s);}});
  for(let i=0;i<9;i++)state.waiters.push(waiter('j'+i));
  const q=make();q.drain();
  assert.equal(claimed.length,9,'10 GB free: 9 x 256 MB + 4096 MB floor fit');
  assert.equal(q.stats().stagingMb,9*256);
  fsx.writeFileSync(file,JSON.stringify({admitMb:1024}));t+=6000;
  for(let i=0;i<9;i++)state.waiters.push(waiter('k'+i));claimed.length=0;
  const q2=make();q2.drain();
  assert.equal(claimed.length,5,'old charge: 10000-6*1024 < 4096 stops after five');
  fsx.unlinkSync(file);
});
test('recoveryRoom: recovering scopes stop blocking Home admission only as far as the knob allows',()=>{
  const os=require('node:os'),path=require('node:path'),fsx=require('node:fs');
  const file=path.join(os.tmpdir(),`vf-hmd-rr-${process.pid}-${Math.random()}.json`);
  const run=room=>{
    if(room===null){try{fsx.unlinkSync(file);}catch{}}else fsx.writeFileSync(file,JSON.stringify({recoveryRoom:room}));
    const state={activeTotal:0,activeByResource:new Map(),activeByJob:new Map(),waiters:[]};const claimed=[];
    const q=api.createQueue({getState:()=>state,getCapacity:()=>9,available:()=>20000,admission:api.createAdmissionReader(file,fsx,0,()=>0),
      claim(w,s){state.waiters.splice(state.waiters.indexOf(w),1);claimed.push(s);}});
    for(let i=0;i<30;i++)state.waiters.push(waiter('r'+i));
    q.drain();assert.equal(claimed.length,9);
    for(const s of claimed)s.phase='native-wait';   // all nine fell back to the server and wait there
    q.drain();return q.stats();
  };
  const def=run(null);
  assert.equal(def.active,11,'default: cap + MAX_RECOVERING as before');assert.equal(def.homeActive,2);
  const wide=run(20);
  assert.equal(wide.homeActive,9,'Home keeps all its slots');assert.equal(wide.active,18);
  const tight=run(4);
  assert.equal(tight.active,13);assert.equal(tight.homeActive,4);
  fsx.unlinkSync(file);
});
test('admission reader: defaults, bounds, cache and missing file',()=>{
  const fsx=require('node:fs');let t=0;let body='{"admitMb":10,"floorMb":999999}';let reads=0;
  const fake={readFileSync:()=>{reads++;return body;}};
  const r=api.createAdmissionReader('/x',fake,5000,()=>t);
  assert.deepEqual(r(),{admitMb:256,floorMb:4096,recoveryRoom:2,maxRecovering:2},'out-of-range values fall back');
  body='{"admitMb":512,"floorMb":6144,"recoveryRoom":20}';assert.deepEqual(r(),{admitMb:256,floorMb:4096,recoveryRoom:2,maxRecovering:2},'cached within 5 s');
  t+=5000;assert.deepEqual(r(),{admitMb:512,floorMb:6144,recoveryRoom:20,maxRecovering:2});assert.equal(reads,2);
  const missing=api.createAdmissionReader('/definitely/missing.json',fsx,0,()=>0);
  assert.deepEqual(missing(),{...api.ADMIT_DEFAULTS});
});

test('maxRecovering knob: more than two native recoveries may run at once; default stays 2',async()=>{
  const run=async limit=>{
    const scopes=[];let active=0,peak=0;const gates=[];
    const leases=new Map();const store={leases};
    const q={valid:s=>scopes.includes(s)};
    api.attachExecution(q,{getContext:()=>store,runIndependent:fn=>fn(),isAborted:()=>false,isMock:()=>false,
      admission:()=>({maxRecovering:limit}),
      runNative:(jobId,fn)=>fn()});
    const one=()=>{
      const s={jobId:'j',phase:'home'};scopes.push(s);
      const lease={boosted:s,released:false};
      leases.set('render',lease);
      return q.native(()=>new Promise(res=>{active++;peak=Math.max(peak,active);gates.push(()=>{active--;res('ok');});}));
    };
    const all=[];for(let i=0;i<5;i++)all.push(one());
    await new Promise(r=>setTimeout(r,350));
    const seen=peak;
    while(gates.length||active){const g=gates.shift();if(g)g();await new Promise(r=>setTimeout(r,130));}
    await Promise.all(all);
    return seen;
  };
  assert.equal(await run(2),2);
  assert.equal(await run(5),5);
});
