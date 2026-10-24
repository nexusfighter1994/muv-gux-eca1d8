import fs from 'node:fs';
import crypto from 'node:crypto';
import homeRam from './home-ram-estimate.cjs';
import homePoolClaim from './home-pool-claim.cjs';
import homeDispatch from './home-dispatch-limit.cjs';

export function withoutHomeFfmpegLane(getContext,runContext,fn){
  const context=getContext();
  if(!context)return fn();
  const lanes=new Set(context.lanes||[]),leases=new Map(context.leases||[]);
  lanes.delete('ffmpeg');leases.delete('ffmpeg');
  return runContext({...context,lanes,leases},fn);
}

// Server RAM estimates for Home dispatches live in home-ram-estimate.cjs (hot-installable).
export const HOME_DISPATCH_MB=homeRam.HOME_DISPATCH_MB;
export const wrapHomeRamEstimate=homeRam.wrapHomeRamEstimate;

export function createHomeQueue({getState,getCapacity,memoryGate,claim,isAborted=()=>false,
  canClaim=()=>true,newNonce=()=>crypto.randomUUID(),now=Date.now,existingScopes=null,initialAdmitted=0}) {
  const scopes=existingScopes||new Map();
  let draining=false,admitted=initialAdmitted;
  const candidate=w=>w.homeKind==='video-normalize-candidate';
  const candidateCount=()=>Array.from(scopes.values()).filter(s=>s.candidate).length;
  const eligible=w=>w.homeKind!=='native-recovery'&&(w.resourceKey==='fflowComposition'
    ||w.resourceKey==='ffmpeg'&&['video-trim','video-normalize','video-normalize-candidate'].includes(w.homeKind))&&!isAborted(w.jobId);
  const claimable=w=>(!candidate(w)||candidateCount()<2)
    &&canClaim(candidate(w)?{...w,homeKind:'video-normalize'}:w,Array.from(scopes.values()));
  const capacity=()=>Math.max(0,Math.min(50,Number(getCapacity())||0));
  const api={
    async drain(){
      if(draining)return;
      draining=true;
      try{
        while(scopes.size<capacity()){
          const state=getState();
          const ordered=state.waiters.filter(eligible).filter(claimable).sort((a,b)=>
            a.priority<b.priority?-1:a.priority>b.priority?1:a.seq-b.seq);
          if(!ordered.length)break;
          const w=ordered[0];
          const allowed=await memoryGate({key:'ffmpegHome',lane:'ffmpeg',jobId:w.jobId,
            opKey:w.opKey||null,quality:w.quality||null,active:scopes.size,limit:capacity()});
          if(!(allowed===true||allowed?.allowed===true))break;
          if(!state.waiters.includes(w)||!eligible(w)||!claimable(w))continue;
          if(scopes.size>=capacity())break;
          const scope={jobId:w.jobId,nonce:newNonce(),resourceKey:w.resourceKey,
            kind:candidate(w)?'video-normalize':w.homeKind||'composition',
            ...(candidate(w)?{candidate:true}:{}),opKey:w.opKey||null,quality:w.quality||null};
          scopes.set(scope.nonce,scope);
          try{claim(w,scope);admitted++;}catch(e){scopes.delete(scope.nonce);throw e;}
        }
      }finally{draining=false;}
    },
    validScope(scope){const stored=scopes.get(scope?.nonce);return !!stored&&stored.jobId===scope.jobId
      &&(stored.kind||'composition')===(scope.kind||'composition');},
    getScope(scope){return api.validScope(scope)?scopes.get(scope.nonce):null;},
    release(scope){if(api.validScope(scope))scopes.delete(scope.nonce);},
    serverView(fn){
      const state=getState(),active=state.activeTotal,resources=new Map(state.activeByResource);
      state.activeTotal=Math.max(0,active-scopes.size);
      for(const scope of scopes.values()){
        const key=scope.resourceKey||'fflowComposition';
        state.activeByResource.set(key,Math.max(0,(state.activeByResource.get(key)||0)-1));
      }
      try{return fn();}finally{
        state.activeTotal=active;
        state.activeByResource.clear();for(const [key,value] of resources)state.activeByResource.set(key,value);
      }
    },
    stats(){const resources={},kinds={},queuedKinds={};for(const scope of scopes.values()){
      const key=scope.resourceKey||'fflowComposition';resources[key]=(resources[key]||0)+1;}
      for(const s of scopes.values())kinds[s.kind]=(kinds[s.kind]||0)+1;
      for(const w of getState().waiters.filter(eligible)){const k=candidate(w)?'video-normalize':w.homeKind||'composition';queuedKinds[k]=(queuedKinds[k]||0)+1;}
      return {capacity:capacity(),active:scopes.size,resources,kinds,queuedKinds,queued:getState().waiters.filter(eligible).length,
      candidateActive:candidateCount(),candidateQueued:getState().waiters.filter(w=>eligible(w)&&candidate(w)).length,
      admitted,checkedAt:new Date(now()).toISOString()};},
  };
  return api;
}

// Recoveries of work the Home PC dropped. The native ffmpeg lane (14) and RAM gate still
// bound the server; maxRunning only limits how many recoveries enter that lane at once.
// A Home outage can drop ~24 jobs at once: 2 at a time could exceed their 900 s admission.
export function createServerPermits({validScope,run,newId=()=>crypto.randomUUID(),now=Date.now,maxRunning=6,maxItems=1000}){
  const items=new Map();
  let running=0;
  const dispatch=()=>{
    for(const [id,item] of items){
      if(running>=maxRunning)break;
      if(item.started||item.controller.signal.aborted)continue;
      item.started=true;running++;
      void run(item.scope.jobId,async()=>{item.state='active';await item.finished;},
        item.controller.signal,item.scope).catch(()=>{item.state='failed';}).finally(()=>{
          running--;items.delete(id);dispatch();
        });
    }
  };
  const api={
    create(scope){
      if(!validScope(scope))throw Object.assign(Error('Invalid or expired Home scope'),{status:409});
      if(typeof scope.requestId==='string'&&scope.requestId.length<=128){
        for(const [id,item] of items){
          if(item.scope.requestId===scope.requestId&&item.scope.nonce===scope.nonce&&item.scope.jobId===scope.jobId){
            item.touched=now();return id;
          }
        }
      }
      if(items.size>=maxItems)throw Object.assign(Error('Home recovery queue is full'),{status:503});
      const id=newId(),controller=new AbortController();
      let release;
      const finished=new Promise(resolve=>release=resolve);
      const item={scope,state:'queued',controller,release,finished,started:false,touched:now()};
      items.set(id,item);
      dispatch();
      return id;
    },
    get(id){const item=items.get(id);if(!item)return null;item.touched=now();return {state:item.state};},
    close(id){const item=items.get(id);if(!item)return;item.controller.abort(Error('Home fallback permit released'));item.release();
      if(!item.started){items.delete(id);dispatch();}},
    sweep(){for(const[id,item]of items)if(now()-item.touched>90000||!validScope(item.scope))api.close(id);},
  };
  return api;
}

export function installHomeAdmission({scheduler,getState,getContext,claim,getAdmission,setAdmission,
  getRelease,setRelease,app,requireOwner,publishState,startPool,getPoolState,
  runIndependent=fn=>fn(),schedule=fn=>setInterval(fn,1000)}){
  if(globalThis.__vfHomeQueue)return globalThis.__vfHomeQueue;
  const requestedCapacity=()=>{
    if(globalThis.__vfHomeQueueEnabled===false)return 0;
    const health=globalThis.__vfHomeCapabilities;
    // 45 s: a loaded server's event loop can delay the 3 s Home probe well past 15 s.
    if(!health?.ready||Date.now()-health.checkedAt>45000)return 0;
    return homeDispatch.dispatchCapacity(health,homeDispatch.readLimit());
  };
  // FFlow-routed claims run ahead of the pool's ready workers (home-pool-claim.cjs).
  const queue=createHomeQueue({getState,getCapacity:requestedCapacity,
    canClaim:homePoolClaim.makeCanClaim({getCapacity:requestedCapacity,
      ...(getPoolState?{readPool:()=>{try{return getPoolState();}catch{return null;}}}:{})}),
    memoryGate:homeRam.wrapHomeGate(request=>scheduler.getMemoryGate()(request)),isAborted:id=>scheduler.isJobAborted(id),
    claim:(w,scope)=>{
      const resolve=w.resolve;
      w.resolve=lease=>resolve({...lease,homeScope:scope});
      claim(w);
    }});
  const originalAdmission=getAdmission();
  setAdmission(function(lane,...args){return lane==='ffmpeg'
    ?queue.serverView(()=>originalAdmission.call(this,lane,...args))
    :originalAdmission.call(this,lane,...args);});
  const originalRelease=getRelease();
  setRelease(function(lane,jobId,success,resource,boosted=false){
    if(lane==='ffmpeg'&&boosted&&typeof boosted==='object'){
      queue.release(boosted);boosted=false;
    }
    // These are recovery reservations for work already counted by its parent scope.
    if(['ffmpegHomeFallback','ffmpegHomeTrimFallback','ffmpegHomeNormalizeFallback'].includes(resource))success=false;
    return originalRelease.call(this,lane,jobId,success,resource,boosted);
  });
  const nativeStats=scheduler.stats;
  scheduler.stats=function(...args){
    const result=nativeStats.apply(this,args),home=queue.stats();
    if(result.ffmpeg){
      result.ffmpeg.active=Math.max(0,result.ffmpeg.active-home.active);
      for(const [key,count] of Object.entries(home.resources))
        if(result.ffmpeg.resources?.[key]!=null)
          result.ffmpeg.resources[key]=Math.max(0,result.ffmpeg.resources[key]-count);
      result.ffmpeg.home=home;
    }
    return result;
  };
  const permits=createServerPermits({validScope:queue.validScope,
    run:(jobId,fn,signal,scope)=>runIndependent(()=>scheduler.run(jobId,'ffmpeg',fn,
      {signal,interactive:true,resourceKey:scope.kind==='video-normalize'?'ffmpegHomeNormalizeFallback':
        scope.kind==='video-trim'?'ffmpegHomeTrimFallback':'ffmpegHomeFallback',
        segmentType:scope.opKey||null,quality:scope.quality||null,operation:'home-native-fallback'}))});
  queue.runRecovery=async(scope,fn,signal)=>{
    const id=permits.create(queue.getScope(scope)),deadline=Date.now()+900000;
    let timer;
    try{
      for(;;){
        if(signal?.aborted)throw signal.reason||Object.assign(Error('Recovery canceled'),{name:'AbortError'});
        const state=permits.get(id)?.state;
        if(state==='active')break;
        if(state!=='queued'||Date.now()>deadline)throw Error('Native recovery reservation unavailable');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      timer=setInterval(()=>permits.get(id),15000);timer.unref?.();
      return await fn();
    }finally{if(timer)clearInterval(timer);permits.close(id);}
  };
  const auth=(req,res,next)=>{
    try{
      const token=fs.readFileSync('/data/runtime/pc-boost-token','utf8').trim();
      const supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');
      const a=Buffer.from(token),b=Buffer.from(supplied);
      if(!token||a.length!==b.length||!crypto.timingSafeEqual(a,b))throw Error('Unauthorized');
      next();
    }catch{res.status(401).json({error:'Unauthorized'});}
  };
  const route='/internal/vf-home-slot';
  const stack=app._router?.stack||app.router?.stack;
  if(Array.isArray(stack)){
    // Remove only our own routes left by an interrupted optional installation.
    for(let index=stack.length-1;index>=0;index--){
      const path=stack[index].route?.path;
      if(typeof path==='string'&&(path.startsWith(route)||path==='/api/pc-boost/home-queue'))stack.splice(index,1);
    }
  }
  app.post(route,auth,(req,res)=>{
    try{
      const trusted=queue.getScope(req.body);
      const requestId=typeof req.body?.requestId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(req.body.requestId)
        ?req.body.requestId:null;
      const id=permits.create(trusted?{...trusted,requestId}:null);res.status(202).json({id,state:'queued'});
    }
    catch(e){res.status(e.status||503).json({error:'Home scope unavailable'});}
  });
  app.get(route+'/:id',auth,(req,res)=>{
    const value=permits.get(req.params.id);value?res.json(value):res.status(404).json({error:'Permit missing'});
  });
  app.delete(route+'/:id',auth,(req,res)=>{permits.close(req.params.id);res.json({ok:true});});
  app.get('/api/pc-boost/home-queue',requireOwner,(_req,res)=>res.json(queue.stats()));
  // Late installation must precede the native terminal404, after parsers and auth guards.
  if(Array.isArray(stack)){
    const terminal=stack.find(l=>l.route?.methods?.get&&l.route.path instanceof RegExp
        &&l.route.path.source.startsWith('^\\/(?!api\\/|files\\/)'))
      ||stack.find(l=>!l.route&&String(l.handle).includes('404')&&String(l.handle).includes('Not found'));
    if(terminal){const routes=stack.filter(l=>typeof l.route?.path==='string'
        &&(l.route.path.startsWith(route)||l.route.path==='/api/pc-boost/home-queue'));
      for(const l of routes)stack.splice(stack.indexOf(l),1);stack.splice(stack.indexOf(terminal),0,...routes);}
  }
  let target=-1,poolStarted=false,lastPublished=0;
  const tick=()=>{
    permits.sweep();
    if(requestedCapacity()>0&&!poolStarted){
      if(startPool)startPool();
      else process.getBuiltinModule('child_process').spawn('python',
        ['/app/engines/fflow/src/core/pc_home_pool.py'],
        {cwd:'/app/engines/fflow',detached:true,stdio:'ignore'}).unref();
      poolStarted=true;
    }
    const stats=queue.stats();
    const flowActive=stats.active-(stats.kinds['video-normalize']||0);
    const flowQueued=stats.queued-(stats.queuedKinds['video-normalize']||0);
    const workers=Math.max(Math.min(requestedCapacity(),flowQueued+flowActive),flowActive);
    if(workers!==target||Date.now()-lastPublished>=5000){
      target=workers;
      lastPublished=Date.now();
      const value={extra:workers,updatedAt:Date.now()};
      if(publishState)publishState(value);
      else{
        const file='/data/runtime/pc-home-admission.json',tmp=file+'.next';
        fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);
      }
    }
    void queue.drain().catch(e=>console.warn('[pc-home-queue] admission deferred',e?.name||'Error'));
  };
  const timer=schedule(tick);timer.unref?.();
  queue.stop=()=>{clearInterval(timer);globalThis.__vfHomeQueueEnabled=false;};
  globalThis.__vfHomeQueue=queue;
  globalThis.__vfHomeContext=getContext;
  tick();
  return queue;
}

export function wrapHomeFflowClient(client,getContext){
  if(client.__vfHomeQueueVersion==='home-only-v5')return;
  const original=client.request;
  client.request=function(path,options={}){
    const home=getContext()?.leases?.get('ffmpeg')?.boosted;
    if(path==='/v1/render'&&options.body&&home&&typeof home==='object')
      options={...options,body:{...options.body,output:{...options.body.output,
        filename:`vfhome-${home.jobId}-${home.nonce}.mp4`}}};
    if(path==='/v1/video/trim'&&options.body&&home?.kind==='video-trim'&&options.body.output==null)
      options={...options,body:{...options.body,
        output:`outputs/video/trim/vfhome-${home.jobId}-${home.nonce}.mp4`}};
    const result=original.call(this,path,options);
    if(!path.startsWith('/v1/jobs/'))return result;
    return Promise.resolve(result).then(value=>{
      if(value?.data?.memory?.execution_location!=='home')return value;
      const {memory,...data}=value.data;
      return {...value,data};
    });
  };
  client.__vfHomeQueue=true;
  client.__vfHomeQueueVersion='home-only-v5';
}
