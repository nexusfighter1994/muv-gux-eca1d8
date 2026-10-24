import fs from 'node:fs';
import crypto from 'node:crypto';
import {createServerPermits} from './home-queue.mjs';
import {readTransferRuntime} from './pc-transfer-api.mjs';
import {createHomeSiglipClient,createHomeSiglipRankSender} from './home-siglip-transport.mjs';
import {createPodSiglip,combineRank} from './runpod/pod-siglip.mjs';
import siglipNativeCap from './siglip-native-cap.cjs';
import pcStatusExtras from './pc-status-extras.cjs';

export function isHomeSiglipEmbedCallback(callback){
  return [
    '()=>k.runSeparate("siglip embed/rank",J4t(),Ne=>M({query:t,...F?{extraQueries:[...Array.isArray(y)?y:[],r].filter(Boolean),negativeQueries:gxe(yWe,E)}:E?.lookAlikes?.length?{negativeQueries:gxe([],E)}:{},shots:ce,deadlineTs:Ne,signal:I}))',
    '()=>(s.embedAndRank||I9)({query:Ne[0]||b,extraQueries:[...Ne.slice(1),b].filter(Boolean),negativeQueries:gxe(yWe,g),shots:Tn.map(Ra=>({shot_id:Ra.index,start_sec:0,end_sec:0,duration_sec:0,thumbnail_url:Ra.thumbnailUrl})),deadlineTs:Date.now()+3e4})',
    '()=>(s.embedAndRank||I9)({query:We,extraQueries:[...Le.slice(1),...ht,b].filter(Boolean),negativeQueries:gxe(se?yWe:[],g),shots:Dn,deadlineTs:Date.now()+12e4})',
    '()=>k.runSeparate("siglip embed/rank",R$t(),Re=>M({query:t,...F?{extraQueries:[...Array.isArray(y)?y:[],r].filter(Boolean),negativeQueries:Wbe(VQe,E)}:E?.lookAlikes?.length?{negativeQueries:Wbe([],E)}:{},shots:ae,deadlineTs:Re,signal:I}))',
    '()=>(a.embedAndRank||hH)({query:Re[0]||b,extraQueries:[...Re.slice(1),b].filter(Boolean),negativeQueries:Wbe(VQe,g),shots:wn.map(ws=>({shot_id:ws.index,start_sec:0,end_sec:0,duration_sec:0,thumbnail_url:ws.thumbnailUrl})),deadlineTs:Date.now()+3e4})',
    '()=>(a.embedAndRank||hH)({query:qe,extraQueries:[...Be.slice(1),...vt,b].filter(Boolean),negativeQueries:Wbe(ne?VQe:[],g),shots:Nn,deadlineTs:Date.now()+12e4})',
    '()=>(a.embedAndRank||ZQ)({query:Je,extraQueries:[...tr.slice(1),...mt,g].filter(Boolean),negativeQueries:ce?dQe:[],shots:pr,deadlineTs:Date.now()+12e4})',
    '()=>(a.embedAndRank||ZQ)({query:Ie[0]||g,extraQueries:[...Ie.slice(1),g].filter(Boolean),negativeQueries:dQe,shots:jn.map(vs=>({shot_id:vs.index,start_sec:0,end_sec:0,duration_sec:0,thumbnail_url:vs.thumbnailUrl})),deadlineTs:Date.now()+3e4})',
    '()=>C.run("siglip embed/rank",Ie=>N({query:t,...F?{extraQueries:[...Array.isArray(y)?y:[],r].filter(Boolean),negativeQueries:dQe}:{},shots:ce,deadlineTs:Ie,signal:k}))',
  ].includes(String(callback));
}

export function createHomeSiglipBufferBudget(maxBytes=512*1024*1024){
  let reserved=0;
  return {
    open(base=8*1024*1024){
      let held=0,closed=false;
      const grow=amount=>{
        if(closed||!Number.isSafeInteger(amount)||amount<0||reserved+amount>maxBytes)
          throw Object.assign(Error('Home SigLIP buffer budget unavailable'),{code:'VF_HOME_SIGLIP_FALLBACK'});
        reserved+=amount;held+=amount;
      };
      grow(base);
      return {addBytes:n=>grow(n*8),close(){if(!closed){closed=true;reserved-=held;}},get heldBytes(){return held;}};
    },
    stats:()=>({reservedBytes:reserved,maxBytes}),
  };
}

export function createHomeSiglipQueue({getState,getCapacity,claim,isAborted=()=>false,
  newNonce=()=>crypto.randomUUID(),scopes=new Map()}){
  let draining=false,admitted=0,completed=0,failed=0;
  const eligible=w=>w.resourceKey==='siglip'&&['siglip-home','siglip-home-candidate'].includes(w.homeKind)&&!isAborted(w.jobId)&&!w.signal?.aborted;
  const capacity=()=>Math.max(0,Math.min(25,Number(getCapacity())||0));
  const candidates=()=>[...scopes.values()].filter(s=>s.candidate).length;
  const q={
    drain(){
      if(draining)return;draining=true;
      try{
        while(scopes.size<capacity()){
          const w=getState().waiters.filter(eligible).filter(w=>w.homeKind!=='siglip-home-candidate'||candidates()<2)
            .sort((a,b)=>a.priority<b.priority?-1:a.priority>b.priority?1:a.seq-b.seq)[0];
          if(!w)break;
          const scope={jobId:w.jobId,nonce:newNonce(),kind:'siglip-embed',resourceKey:'siglip',
            candidate:w.homeKind==='siglip-home-candidate',signal:w.signal,opKey:w.opKey,quality:w.quality};
          scopes.set(scope.nonce,scope);
          try{claim(w,scope);admitted++;}catch(error){scopes.delete(scope.nonce);throw error;}
        }
      }finally{draining=false;}
    },
    validScope:s=>!!s&&scopes.get(s.nonce)?.jobId===s.jobId&&scopes.get(s.nonce)?.kind===s.kind,
    getScope:s=>q.validScope(s)?scopes.get(s.nonce):null,
    statsSubmitted:()=>[...scopes.values()].filter(s=>s.pcSubmitted).length,
    release(s,success){if(q.validScope(s)){scopes.delete(s.nonce);success?completed++:failed++;}},
    serverView(fn){
      const s=getState(),total=s.activeTotal,count=s.activeByResource.get('siglip')||0;
      s.activeTotal=Math.max(0,total-scopes.size);s.activeByResource.set('siglip',Math.max(0,count-scopes.size));
      try{return fn();}finally{s.activeTotal=total;count?s.activeByResource.set('siglip',count):s.activeByResource.delete('siglip');}
    },
    stats(){return {capacity:capacity(),active:scopes.size,queued:getState().waiters.filter(eligible).length,
      candidateActive:candidates(),recovering:[...scopes.values()].filter(s=>s.recovering).length,
      submitted:[...scopes.values()].filter(s=>s.pcSubmitted).length,admitted,completed,failed,checkedAt:new Date().toISOString()};},
  };
  return q;
}

export function attachHomeSiglipRecovery(queue,{runNative,runNativeContext,isAborted=()=>false}){
  const permits=createServerPermits({validScope:queue.validScope,run:runNative});
  queue.runCallback=async(scope,callback)=>{
    scope=queue.getScope(scope);
    if(!scope)throw Error('Expired Home SigLIP scope');
    const controller=new AbortController();
    scope.signal=scope.signal?AbortSignal.any([scope.signal,controller.signal]):controller.signal;
    const poll=setInterval(()=>{if(isAborted(scope.jobId))controller.abort(Object.assign(Error('SigLIP job aborted'),{name:'AbortError'}));},250);
    poll.unref?.();
    try{
    const canceled=()=>{scope.signal?.throwIfAborted();if(isAborted(scope.jobId))throw Object.assign(Error('SigLIP job aborted'),{name:'AbortError'});};
    canceled();
    if(isHomeSiglipEmbedCallback(callback)){
      scope.candidate=false;
      try{return await callback();}catch(error){canceled();if(error?.code!=='VF_HOME_SIGLIP_FALLBACK')throw error;}
    }
    scope.recovering=true;
    const id=permits.create(scope);let heartbeat;
    try{
      for(;;){
        canceled();const state=permits.get(id)?.state;
        if(state==='active')break;
        if(state!=='queued')throw Error('Native SigLIP recovery reservation unavailable');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      heartbeat=setInterval(()=>permits.get(id),15000);heartbeat.unref?.();
      return await runNativeContext(scope,callback);
    }finally{if(heartbeat)clearInterval(heartbeat);permits.close(id);scope.recovering=false;}
    }finally{clearInterval(poll);}
  };
  queue.recoveries=()=>permits;
  return queue;
}

export function installHomeSiglipAdmission({scheduler,getState,getContext,claim,getAdmission,setAdmission,
  getRelease,setRelease,getSlotMeasurer,setSlotMeasurer,runIndependent,runNativeContext,
  getCapacity,getEmbedder,setEmbedder,app,requireOwner,schedule=fn=>setInterval(fn,500)}){
  if(globalThis.__vfHomeSiglipQueue)return globalThis.__vfHomeSiglipQueue;
  const queue=createHomeSiglipQueue({getState,getCapacity,claim:(w,s)=>{
    const resolve=w.resolve;w.resolve=lease=>resolve({...lease,cooldownProbe:false,homeScope:s});claim(w);
  },isAborted:id=>scheduler.isJobAborted(id)});
  attachHomeSiglipRecovery(queue,{isAborted:id=>scheduler.isJobAborted(id),runNativeContext,
    runNative:(jobId,fn,signal,scope)=>runIndependent(()=>scheduler.run(jobId,'siglip',fn,
      {signal,interactive:true,resourceKey:'siglip',homeKind:'siglip-native-recovery',operation:'home-siglip-native-recovery',segmentType:scope.opKey,quality:scope.quality}))});
  const admission=getAdmission();
  setAdmission(function(lane,...args){return lane==='siglip'?queue.serverView(()=>admission.call(this,lane,...args)):admission.call(this,lane,...args);});
  const release=getRelease();
  setRelease(function(lane,jobId,success,resource,boosted){
    boosted=siglipNativeCap.releaseToken(lane,boosted);
    if(lane==='siglip'&&queue.validScope(boosted)){queue.release(boosted,success);boosted=false;}
    return release.call(this,lane,jobId,success,resource,boosted);
  });
  const sampler=getSlotMeasurer();
  setSlotMeasurer(function(request){
    if(request?.lane!=='siglip'||request.resourceKey!=='ffmpegHome')return sampler?.call(this,request);
    return {run:callback=>queue.runCallback(getContext()?.leases?.get('siglip')?.boosted,callback),finish(){}};
  });
  const run=scheduler.run;
  const wrappedRun=function(jobId,lane,callback,options){
    if(lane==='siglip'&&options?.homeKind!=='siglip-native-recovery')
      options={...options,homeKind:isHomeSiglipEmbedCallback(callback)?'siglip-home':'siglip-server'};
    return run.call(this,jobId,lane,callback,options);
  };
  wrappedRun.__vfHomeDirect=run.__vfHomeDirect;wrappedRun.__vfHomeLibraryTrim=run.__vfHomeLibraryTrim;
  wrappedRun.__vfHomeSiglip=true;scheduler.run=wrappedRun;
  const stats=scheduler.stats;
  scheduler.stats=function(...args){
    const value=stats.apply(this,args),home=queue.stats();
    if(value.siglip){value.siglip.active=Math.max(0,value.siglip.active-home.active);value.siglip.home=home;}
    return value;
  };
  // While the PC SigLIP is healthy the native lane takes at most one embedding (siglip-native-cap.cjs);
  // the dispatcher getter comes from scheduler-dispatch-install.py.
  if(globalThis.__vfSchedulerDispatch)globalThis.__vfSchedulerDispatch=siglipNativeCap.wrapDispatch(globalThis.__vfSchedulerDispatch,getAdmission);
  globalThis.__vfHomeSiglipQueue=queue;
  globalThis.__vfHomeSiglipScope=()=>queue.getScope(getContext()?.leases?.get('siglip')?.boosted);
  globalThis.__vfHomeSiglipAttachSignal=signal=>{
    const scope=globalThis.__vfHomeSiglipScope();
    if(scope&&signal&&typeof signal.addEventListener==='function')
      scope.signal=scope.signal?AbortSignal.any([scope.signal,signal]):signal;
  };
  if(getEmbedder&&setEmbedder){
    const original=getEmbedder();
    const linked=function(payload){globalThis.__vfHomeSiglipAttachSignal(payload?.signal);return original.call(this,payload);};
    linked.__vfHomeSiglipSignal=true;setEmbedder(linked);
  }
  globalThis.__vfHomeSiglipRecovery=()=>getContext()?.homeSiglipRecovery===true;
  globalThis.__vfHomeSiglipBuffers=createHomeSiglipBufferBudget();
  let migrated=0;
  for(const waiter of getState().waiters)if(waiter.resourceKey==='siglip'&&!waiter.homeKind){waiter.homeKind='siglip-home-candidate';migrated++;}
  queue.migrated=migrated;
  const stack=app?._router?.stack||app?.router?.stack;
  for(const layer of stack||[])if(layer.route?.path==='/api/pc-boost'&&layer.route.methods.get){
    const entry=layer.route.stack.at(-1),original=entry.handle;
    entry.handle=function(req,res,next){const send=res.json;res.json=function(body){res.json=send;return send.call(this,{...body,homeSiglipQueue:queue.stats()});};return original.call(this,req,res,next);};
  }
  pcStatusExtras.wrapStatusRoute(app);
  const timer=schedule(()=>{queue.recoveries().sweep();queue.drain();});timer.unref?.();queue.timer=timer;
  return queue;
}

export function startHomeSiglipHealth({readConfig,readToken,url,now=Date.now,schedule=fn=>setInterval(fn,3000)}){
  let health=null,at=0,busy=false;
  const probe=async()=>{
    if(busy)return;busy=true;
    try{
      const config=readConfig();
      if(config.enabled!==true||config.siglipEnabled!==true){health=null;return;}
      const response=await fetch(url+'/health',{headers:{Authorization:'Bearer '+readToken()},signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('PC health unavailable');
      const value=await response.json();
      if(value.ready!==true||value.device!=='cuda'||value.model_id!=='google/siglip2-base-patch16-384'
        ||value.model_revision!=='f775b65a79762255128c981547af89addcfe0f88'||value.multi_query!==true){health=null;return;}
      health=value;at=now();
    // A probe lost to event-loop lag keeps the last good health; getCapacity still expires it after 10 s.
    }catch{}finally{busy=false;}
  };
  const timer=schedule(probe);timer.unref?.();void probe();
  return {getCapacity(){
    try{
      const config=readConfig();if(config.enabled!==true||config.siglipEnabled!==true||!health||now()-at>=10000)return 0;
      const own=globalThis.__vfHomeSiglipQueue?.statsSubmitted?.()||0;
      const external=Math.max(0,(Number(health.active_tasks)||0)-own);
      return Math.max(0,Math.min(25,config.siglipConcurrency,health.configured_concurrency)-external);
    }catch{return 0;}
  },snapshot:()=>({health,checkedAt:at}),timer};
}

export function installHomeSiglipStartup(deps){
  if(globalThis.__vfHomeSiglipStartup)return;
  let timer;
  const connect=()=>{
    const client=deps.getClient(),fflow=deps.getFflow();
    if(!client?.__vfcSiglip||!fflow)return;
    const readConfig=()=>JSON.parse(fs.readFileSync(process.env.VF_PC_BOOST_CONFIG||'/data/runtime/pc-boost.json','utf8'));
    const readToken=()=>fs.readFileSync(process.env.VF_PC_BOOST_TOKEN_FILE||'/data/runtime/pc-boost-token','utf8').trim();
    const url=(process.env.VF_PC_BOOST_SIGLIP_URL||'http://10.0.3.1:18194').replace(/\/$/,'');
    const health=startHomeSiglipHealth({readConfig,readToken,url});
    // A ready RunPod burst pod adds its SigLIP GPU slots (node/runpod/pod-siglip.mjs).
    const pod=createPodSiglip({getScope:globalThis.__vfHomeSiglipScope,budget:globalThis.__vfHomeSiglipBuffers,
      readTransfer:()=>readTransferRuntime().limits,fflow});
    globalThis.__vfPodSiglip=pod;
    const queue=installHomeSiglipAdmission({...deps,getCapacity:()=>health.getCapacity()+pod.capacity()});
    const rankPc=createHomeSiglipRankSender({getScope:globalThis.__vfHomeSiglipScope,
      budget:globalThis.__vfHomeSiglipBuffers,readConfig,readToken,readTransfer:()=>readTransferRuntime().limits,url,fflow});
    const rankHome=combineRank({rankHome:rankPc,homeCapacity:health.getCapacity,pod});
    createHomeSiglipClient({client,getScope:globalThis.__vfHomeSiglipScope,isRecovery:globalThis.__vfHomeSiglipRecovery,rankHome});
    globalThis.__vfHomeSiglipTransportStats=client.__vfHomeSiglipTransport.stats;
    globalThis.__vfHomeSiglipHealth=health;
    queue.health=health;clearInterval(timer);
  };
  timer=setInterval(()=>{try{connect();}catch(error){console.warn('[home-siglip] startup deferred',error?.name);}},1000);timer.unref();
  globalThis.__vfHomeSiglipStartup={timer};connect();
}
