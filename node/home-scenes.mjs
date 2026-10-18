export const SCENE_CALLBACK_HASH='616e871d436c22cf95b2d2c3245aa3e865d173825ff96e8a2b807d88ddb7b889';
export function wrapHomeScenes(original,d){
  return async function(r){
    const lease=d.getContext()?.leases?.get('ffmpeg'),scope=lease?.boosted;
    if(scope?.kind!=='video-trim')return original.call(this,r);
    const signal=r.signal||lease.signal;
    const check=()=>{if(signal?.aborted)throw signal.reason||Error('Cancelled');
      if(!d.validScope(scope))throw Error('Scene scope expired');};
    check();
    const budgetMs=Math.min(90000,Number(r.deadlineTs)-Date.now()-60000);
    if(d.enabled()&&budgetMs>=15000){
      scope.candidate=false;d.stats.attempted++;
      try{
        const result=await d.runCli({...r,jobId:scope.jobId,budgetMs},signal);
        check();
        if(result?.offloaded&&result.verified&&Array.isArray(result.shots)&&result.shots.length){
          if(!/^[a-zA-Z0-9_-]+$/.test(result.projectSlug||''))throw Error('Project scope');
          const publish=r.publishFile||await d.getPublisher();
          const shots=result.shots.map(s=>{const {thumbnailPath,...shot}=s;
            if(typeof thumbnailPath!=='string'||thumbnailPath.includes('/../')||!thumbnailPath.startsWith('/data/projects/'+result.projectSlug+'/home-scene-previews/'+scope.jobId+'/'))throw Error('Preview scope');
            return {...shot,thumbnail_url:publish(thumbnailPath,'scene-'+process.getBuiltinModule('crypto').randomUUID()+'.jpg')};});
          d.stats[result.backend==='NVDEC + CPU scenes'?'gpu':'cpu']++;
          try{d.record(scope,result.backend);}catch{}
          return {shots,videoFps:result.videoFps};
        }
      }catch(error){check();if(error?.name==='AbortError')throw error;}
    }
    d.stats.fallback++;check();
    return d.runRecovery(scope,()=>d.runNativeContext(scope,()=>original.call(this,r)),signal);
  };
}
export function installHomeScenes(d){
  if(globalThis.__vfHomeScenes?.version>=2)return globalThis.__vfHomeScenes;
  const previous=globalThis.__vfHomeScenes;
  if(previous&&!d.originalRender)throw Error('Original scene renderer required for update');
  if(!Array.isArray(d.getState()?.waiters)||typeof d.getRender()!=='function')throw Error('Scene native dependencies');
  const stats=previous?.stats||{attempted:0,gpu:0,cpu:0,fallback:0,tagged:0,pendingTagged:0};
  d.setRender(wrapHomeScenes(d.originalRender||d.getRender(),{...d,stats}));
  if(!globalThis.__vfHomeQueue.sceneStatusAttached){
    const originalStats=globalThis.__vfHomeQueue.stats;
    globalThis.__vfHomeQueue.stats=function(){return {...originalStats.call(this),scenes:{...stats}}};
    globalThis.__vfHomeQueue.sceneStatusAttached=true;
  }
  if(previous){previous.version=2;return previous;}
  const matches=fn=>d.hash(String(fn))===SCENE_CALLBACK_HASH;
  const sampler=d.getSlotMeasurer();
  d.setSlotMeasurer(function(request){const sample=sampler?.call(this,request);
    if(request?.resourceKey!=='ffmpegHome')return sample;
    return {run(callback){const scope=d.getContext()?.leases?.get('ffmpeg')?.boosted;
      if(scope?.candidate&&scope.kind==='video-normalize'&&matches(callback))scope.kind='video-trim';
      return sample?.run?sample.run(callback):callback();},finish(...args){return sample?.finish?.(...args);}};});
  const run=d.scheduler.run;
  d.scheduler.run=function(job,resource,callback,options){
    if(resource==='ffmpeg'&&d.enabled()&&matches(callback)){stats.tagged++;options={...options,homeKind:'video-normalize-candidate'};}
    return run.call(this,job,resource,callback,options);};
  for(const w of d.getState().waiters)if(w.resourceKey==='ffmpeg'&&w.opKey==='b_roll_video'&&!w.homeKind){
    w.homeKind='video-normalize-candidate';stats.pendingTagged++;}
  return globalThis.__vfHomeScenes={version:2,stats,activatedAt:new Date().toISOString()};
}
