import test from 'node:test';
import assert from 'node:assert/strict';

const module=await import('../node/home-queue.mjs').catch(()=>({}));

test('native recovery clears only its reentrant Home FFmpeg lane and preserves other context',()=>{
  assert.equal(typeof module.withoutHomeFfmpegLane,'function');
  const context={jobId:'job',lanes:new Set(['llm','ffmpeg']),
    leases:new Map([['llm',{id:'llm'}],['ffmpeg',{boosted:{kind:'video-normalize'}}]])};
  let seen;
  const result=module.withoutHomeFfmpegLane(()=>context,(value,fn)=>{seen=value;return fn();},()=>42);
  assert.equal(result,42);assert.equal(seen.jobId,'job');
  assert.deepEqual([...seen.lanes],['llm']);assert.deepEqual([...seen.leases.keys()],['llm']);
  assert.equal(context.lanes.has('ffmpeg'),true);assert.equal(context.leases.has('ffmpeg'),true);
});

function fixture(capacity=2){
  assert.equal(typeof module.createHomeQueue,'function','independent Home admission is missing');
  const state={activeTotal:14,activeByResource:new Map([['fflowComposition',2],['ffmpeg',12]]),waiters:[]};
  let cap=capacity,n=0;
  const claimed=[];
  const queue=module.createHomeQueue({getState:()=>state,getCapacity:()=>cap,newNonce:()=>String(++n),
    memoryGate:async()=>true,isAborted:id=>id==='aborted',
    claim:(waiter,scope)=>{state.waiters.splice(state.waiters.indexOf(waiter),1);state.activeTotal++;
      state.activeByResource.set('fflowComposition',(state.activeByResource.get('fflowComposition')||0)+1);
      claimed.push({waiter,scope});}});
  return {state,queue,claimed,setCapacity:v=>{cap=v}};
}

test('Home can claim ordered work while all fourteen normal server slots are busy',async()=>{
  const f=fixture();
  f.state.waiters.push({jobId:'later',priority:'b',seq:2,resourceKey:'fflowComposition'},
    {jobId:'direct',priority:'a',seq:0,resourceKey:'ffmpeg'},
    {jobId:'first',priority:'a',seq:1,resourceKey:'fflowComposition'});
  await f.queue.drain();
  assert.deepEqual(f.claimed.map(x=>x.waiter.jobId),['first','later']);
  assert.equal(f.queue.stats().active,2);
  assert.equal(f.state.activeTotal,16);
  assert.equal(f.state.waiters[0].jobId,'direct');
  assert.equal(f.queue.serverView(()=>f.state.activeTotal),14);
  assert.equal(f.state.activeTotal,16,'temporary accounting restored');
});

test('duplicate drains and cancellations never claim the same waiter twice',async()=>{
  const f=fixture();
  f.state.waiters.push({jobId:'one',priority:'a',seq:1,resourceKey:'fflowComposition'},
    {jobId:'aborted',priority:'a',seq:2,resourceKey:'fflowComposition'});
  await Promise.all([f.queue.drain(),f.queue.drain()]);
  assert.equal(f.claimed.length,1);
  const scope=f.claimed[0].scope;
  assert.equal(f.queue.validScope(scope),true);
  assert.equal(f.queue.validScope({...scope,nonce:'other'}),false);
  f.queue.release(scope);f.queue.release(scope);
  assert.equal(f.queue.stats().active,0);
  assert.equal(f.queue.validScope(scope),false);
});

test('offline Home stops new claims but preserves existing scoped work for controlled fallback',async()=>{
  const f=fixture(1);
  f.state.waiters.push({jobId:'one',priority:'a',seq:1,resourceKey:'fflowComposition'},
    {jobId:'two',priority:'a',seq:2,resourceKey:'fflowComposition'});
  await f.queue.drain();f.setCapacity(0);await f.queue.drain();
  assert.equal(f.claimed.length,1);
  assert.equal(f.queue.validScope(f.claimed[0].scope),true);
  assert.equal(f.queue.stats().queued,1);
});

test('normal fallback permits use native server admission, are abortable and release once',async()=>{
  assert.equal(typeof module.createServerPermits,'function','controlled fallback admission is missing');
  let release,active=0;
  const pending=[];
  const permits=module.createServerPermits({validScope:scope=>scope.nonce==='nonce',newId:()=>String(pending.length),
    run:async(jobId,fn,signal)=>{pending.push({jobId,signal});await new Promise(r=>release=r);
      if(signal.aborted)throw signal.reason;active++;try{return await fn()}finally{active--;}}});
  const id=permits.create({jobId:'one',nonce:'nonce'});
  assert.equal(permits.get(id).state,'queued');assert.equal(active,0);
  release();await new Promise(r=>setTimeout(r,0));
  assert.equal(permits.get(id).state,'active');assert.equal(active,1);
  permits.close(id);permits.close(id);await new Promise(r=>setTimeout(r,0));
  assert.equal(active,0);
  assert.throws(()=>permits.create({jobId:'one',nonce:'bad'}),undefined);
});

test('a Home outage recovers six at once by default and accepts far more than 100 waiting',async()=>{
  let n=0;const started=[];
  const permits=module.createServerPermits({validScope:()=>true,newId:()=>String(++n),
    run:async(jobId,fn)=>{started.push(jobId);await fn();}});
  const ids=Array.from({length:150},(_,i)=>permits.create({jobId:'j'+i}));
  assert.equal(started.length,6);assert.equal(ids.length,150);
  for(const id of ids)permits.close(id);await new Promise(r=>setTimeout(r,0));
});

test('at most maxRunning in-flight Home recoveries enter native admission and canceled pending work is removed',async()=>{
  let n=0;const started=[];
  const permits=module.createServerPermits({validScope:()=>true,newId:()=>String(++n),maxRunning:2,
    run:async(jobId,fn)=>{started.push(jobId);await fn();}});
  const a=permits.create({jobId:'a'}),b=permits.create({jobId:'b'}),c=permits.create({jobId:'c'});
  assert.deepEqual(started,['a','b']);assert.equal(permits.get(c).state,'queued');
  permits.close(c);assert.equal(permits.get(c),null);
  permits.close(a);permits.close(b);await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(started,['a','b']);
});

test('retrying one lost permit-creation response cannot reserve the server twice',async()=>{
  let n=0;const started=[];
  const permits=module.createServerPermits({validScope:()=>true,newId:()=>String(++n),
    run:async(jobId,fn)=>{started.push(jobId);await fn();}});
  const scope={jobId:'job',nonce:'scope',kind:'composition',requestId:'request'};
  const first=permits.create(scope),again=permits.create({...scope});
  assert.equal(again,first);assert.deepEqual(started,['job']);
  const other=permits.create({...scope,requestId:'other'});
  assert.notEqual(other,first);assert.equal(started.length,2);
  permits.close(first);permits.close(other);
  await new Promise(r=>setTimeout(r,0));
});

test('installation preserves array-valued native routes and replaces only interrupted Home routes',()=>{
  assert.equal(typeof module.installHomeAdmission,'function');
  delete globalThis.__vfHomeQueue;globalThis.__vfHomeAdmissionReady=false;
  const terminal={handle:function(req,res){return res.status(404).json({error:'Not found'});}};
  const native={route:{path:['/custom','/settings/custom']}};
  const stack=[native,{route:{path:'/internal/vf-home-slot'}},terminal];
  const app={_router:{stack}};
  for(const method of ['get','post','delete'])app[method]=(path,...args)=>stack.push({route:{path},handle:args.at(-1)});
  let admission=()=>null,release=()=>{};
  const state={activeTotal:14,activeByResource:new Map(),activeByJob:new Map(),waiters:[]};
  const scheduler={getMemoryGate:()=>async()=>true,isJobAborted:()=>false,stats:()=>({}),run:()=>Promise.resolve()};
  module.installHomeAdmission({scheduler,getState:()=>state,getContext:()=>null,claim:()=>{},
    getAdmission:()=>admission,setAdmission:f=>{admission=f},getRelease:()=>release,setRelease:f=>{release=f},
    app,requireOwner:()=>{},publishState:()=>{},schedule:()=>({unref(){}})});
  assert.equal(stack.filter(l=>l.route?.path==='/internal/vf-home-slot').length,1);
  assert.equal(stack[0],native);
  assert.ok(stack.indexOf(terminal)>stack.findIndex(l=>l.route?.path==='/internal/vf-home-slot'));
  delete globalThis.__vfHomeQueue;delete globalThis.__vfHomeAdmissionReady;
});

test('private permit GET is installed before the native SPA catch-all, not returned as HTML',()=>{
  delete globalThis.__vfHomeQueue;globalThis.__vfHomeQueueEnabled=false;
  const spa={route:{path:/^\/(?!api\/|files\/).*/,methods:{get:true}},
    handle:function(req,res){return res.sendFile('index.html')}};
  const terminal={handle:function(req,res){return res.status(404).json({error:'Not found'})}};
  const stack=[spa,terminal],app={_router:{stack}};
  for(const method of ['get','post','delete'])app[method]=(path,...args)=>stack.push({route:{path,methods:{[method]:true}},handle:args.at(-1)});
  let admission=()=>null,release=()=>{};
  const state={activeTotal:14,activeByResource:new Map(),activeByJob:new Map(),waiters:[]};
  const scheduler={getMemoryGate:()=>async()=>true,isJobAborted:()=>false,stats:()=>({}),run:()=>Promise.resolve()};
  module.installHomeAdmission({scheduler,getState:()=>state,getContext:()=>null,claim:()=>{},
    getAdmission:()=>admission,setAdmission:f=>admission=f,getRelease:()=>release,setRelease:f=>release=f,
    app,requireOwner:()=>{},publishState:()=>{},schedule:()=>({unref(){}})});
  const get=stack.find(l=>l.route?.path==='/internal/vf-home-slot/:id'&&l.route.methods.get);
  assert.ok(stack.indexOf(get)<stack.indexOf(spa),'SPA swallowed the private JSON poll endpoint');
  state.activeByJob.set('unrelated-job',1);scheduler.isJobRegistered=()=>true;
  const post=stack.find(l=>l.route?.path==='/internal/vf-home-slot'&&l.route.methods.post);
  let status,response;
  post.handle({body:{jobId:'unrelated-job',nonce:'expired',kind:'composition'}},
    {status:value=>{status=value;return {json:value=>{response=value}}},json:value=>{response=value}});
  assert.equal(status,409,'Unrelated native work must never authorize an expired Home scope');
  assert.notEqual(response?.state,'already_reserved');
  delete globalThis.__vfHomeQueue;delete globalThis.__vfHomeQueueEnabled;
});

test('Home admission waits for registered independent workers, never changes the native worker target',async()=>{
  delete globalThis.__vfHomeQueue;
  globalThis.__vfHomeQueueEnabled=true;
  globalThis.__vfHomeCapabilities={ready:true,checkedAt:Date.now(),capacity:24};
  let pool={mode:'home-only',ready:true,checkedAt:Date.now(),readyWorkers:0};
  let admission=()=>null,release=()=>{},tick;
  const published=[];
  const app={_router:{stack:[]},get(){},post(){},delete(){}};
  const state={activeTotal:14,activeByResource:new Map(),activeByJob:new Map(),
    waiters:Array.from({length:24},(_,i)=>({jobId:'job'+i,resourceKey:'fflowComposition',priority:'a',seq:i}))};
  const scheduler={getMemoryGate:()=>async()=>true,isJobAborted:()=>false,stats:()=>({}),run:()=>Promise.resolve()};
  const queue=module.installHomeAdmission({scheduler,
    getState:()=>state,
    getContext:()=>null,claim:w=>{state.waiters.splice(state.waiters.indexOf(w),1);state.activeTotal++;},getAdmission:()=>admission,setAdmission:f=>admission=f,
    getRelease:()=>release,setRelease:f=>release=f,app,requireOwner:()=>{},
    publishState:v=>published.push(v),startPool:()=>{},getPoolState:()=>pool,
    schedule:fn=>{tick=fn;return {unref(){}}}});
  await queue.drain();
  assert.equal(queue.stats().active,0,'Unregistered pickup processes cannot admit FFlow work');
  assert.equal(published[0].extra,24,'Pool warmup receives desired capacity independently');
  pool={...pool,readyWorkers:3};tick();
  await new Promise(r=>setTimeout(r,0));
  assert.equal(queue.stats().active,3);
  delete globalThis.__vfHomeQueue;delete globalThis.__vfHomeQueueEnabled;delete globalThis.__vfHomeCapabilities;
});

test('Home dispatch and server fallback have separate nonzero RAM estimates without changing native estimates',()=>{
  assert.equal(typeof module.wrapHomeRamEstimate,'function');
  const calls=[];
  const original=req=>{calls.push(req.resourceKey);return {mb:req.resourceKey==='fflowComposition'?1536:0,
    source:'cold',sampleCount:0,profileKey:req.resourceKey}};
  const wrapped=module.wrapHomeRamEstimate(original);
  assert.equal(wrapped({resourceKey:'ffmpegHome'}).mb,160);
  assert.equal(wrapped({resourceKey:'ffmpegHomeFallback'}).mb,1536);
  assert.equal(wrapped({resourceKey:'fflowComposition'}).mb,1536);
  assert.equal(wrapped({resourceKey:'other'}).mb,0);
  assert.deepEqual(calls,['ffmpegHome','fflowComposition','fflowComposition','other']);
  const learned=module.wrapHomeRamEstimate(()=>({mb:6,source:'learned',sampleCount:20,profileKey:'fixture'}));
  assert.equal(learned({resourceKey:'ffmpegHomeFallback'}).mb,1536);
  assert.equal(learned({resourceKey:'ffmpegHomeTrimFallback'}).mb,512);
  assert.equal(learned({resourceKey:'fflowComposition'}).mb,6,'Native budget evidence is not rewritten');
});

test('hot upgrade: a running v5 wrapper (512 MB) is overridden once; v6 is idempotent',()=>{
  const native=req=>({mb:req.resourceKey==='fflowComposition'?1536:0,source:'cold',sampleCount:0,profileKey:req.resourceKey});
  const v5=req=>(req.resourceKey==='ffmpegHome'?{...native(req),mb:512}:native(req));
  v5.__vfHomeRamVersion='home-only-v5';
  const v6=module.wrapHomeRamEstimate(v5);
  assert.notEqual(v6,v5);
  assert.equal(v6({resourceKey:'ffmpegHome'}).mb,module.HOME_DISPATCH_MB);
  assert.equal(module.HOME_DISPATCH_MB,160);
  assert.equal(v6({resourceKey:'fflowComposition'}).mb,1536);
  assert.equal(module.wrapHomeRamEstimate(v6),v6);
});

test('only verified remote-only RAM evidence is excluded from the native composition learner',async()=>{
  const values=[{data:{memory:{incremental_peak_mb:6,execution_location:'home'},status:'completed',output_path:'video.mp4'}},
    {data:{memory:{incremental_peak_mb:1536},status:'completed'}},
    {data:{memory:{incremental_peak_mb:6,execution_location:'mixed'},status:'completed'}}];
  const client={request:async()=>values.shift()};
  module.wrapHomeFflowClient(client,()=>null);
  const home=await client.request('/v1/jobs/test');
  assert.equal(home.data.memory,undefined);assert.equal(home.data.output_path,'video.mp4');
  assert.equal((await client.request('/v1/jobs/test')).data.memory.incremental_peak_mb,1536);
  assert.equal((await client.request('/v1/jobs/test')).data.memory.execution_location,'mixed');
});

test('only explicitly identified native video trims join the Home queue and resource accounting stays separate',async()=>{
  const state={activeTotal:14,activeByResource:new Map([['ffmpeg',14]]),waiters:[
    {jobId:'trim',priority:'a',seq:1,resourceKey:'ffmpeg',homeKind:'video-trim'},
    {jobId:'unknown',priority:'a',seq:2,resourceKey:'ffmpeg'}]};
  const claimed=[];
  const queue=module.createHomeQueue({getState:()=>state,getCapacity:()=>1,memoryGate:async()=>true,
    claim:(w,s)=>{state.waiters.splice(state.waiters.indexOf(w),1);state.activeTotal++;
      state.activeByResource.set(w.resourceKey,15);claimed.push(s);}});
  await queue.drain();
  assert.equal(claimed.length,1);assert.equal(claimed[0].kind,'video-trim');
  assert.equal(queue.serverView(()=>state.activeByResource.get('ffmpeg')),14);
  assert.equal(state.activeByResource.get('ffmpeg'),15);
  assert.equal(state.waiters[0].jobId,'unknown');
});

test('the native video-trim body is tagged without changing source, cuts, FPS or trim mode',async()=>{
  let received;
  const scope={jobId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',nonce:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',kind:'video-trim'};
  const client={request:async(path,options)=>{received={path,options};return {data:{job_id:'fixture'}}}};
  module.wrapHomeFflowClient(client,()=>({leases:new Map([['ffmpeg',{boosted:scope}]])}));
  const original={source:'inputs/native-original.mp4',start_time:3.25,end_time:9.5,fps:30,trim_mode:'accurate',wait_for_results:false};
  await client.request('/v1/video/trim',{body:original,method:'POST',licensed:true});
  assert.equal(received.options.body.output,'outputs/video/trim/vfhome-'+scope.jobId+'-'+scope.nonce+'.mp4');
  const {output,...rest}=received.options.body;assert.deepEqual(rest,original);
  assert.equal(received.options.licensed,true);
  await client.request('/v1/scenes/detect',{body:original,method:'POST',licensed:true});
  assert.deepEqual(received.options.body,original,'Unverified endpoints retain native behavior');
});

test('normalization can use the PC directly without warming unused FFlow consumers',async()=>{
  const state={activeTotal:14,activeByResource:new Map([['ffmpeg',14]]),waiters:[
    {jobId:'norm',priority:'a',seq:1,resourceKey:'ffmpeg',homeKind:'video-normalize'},
    {jobId:'trim',priority:'a',seq:2,resourceKey:'ffmpeg',homeKind:'video-trim'}]};
  const claimed=[];
  const queue=module.createHomeQueue({getState:()=>state,getCapacity:()=>24,memoryGate:async()=>true,
    canClaim:w=>w.homeKind==='video-normalize',
    claim:(w,s)=>{state.waiters.splice(state.waiters.indexOf(w),1);state.activeTotal++;
      state.activeByResource.set('ffmpeg',15);claimed.push(s);}});
  await queue.drain();assert.equal(claimed.length,1);assert.equal(claimed[0].kind,'video-normalize');
  assert.equal(queue.stats().kinds['video-normalize'],1);
  assert.equal(queue.stats().queuedKinds['video-trim'],1);
});
