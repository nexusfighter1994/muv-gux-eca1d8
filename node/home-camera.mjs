export const CAMERA_CALLBACK_HASHES=new Set([
  '77605c64a860a001e84d7a264d67bff82347a5c7840d237fd75b8254c66fa765',
  'a63050a428ce233c56b30f4a7252091c3bfcc38153b123bea64b31e0f1ff5542',
]);
export function cameraRequestAllowed(r){
  if(!r||Object.keys(r).sort().join(',')!=='camera_path,duration_frames,fps,source,target_resolution,wait_for_results')return false;
  const c=r.camera_path;
  return /^source\.(png|jpe?g|webp)$/.test(r.source)&&r.target_resolution==='1920x1080'
    &&r.fps===24&&Number.isInteger(r.duration_frames)&&r.duration_frames>0&&r.duration_frames<=360
    &&r.wait_for_results===false&&c&&typeof c==='object'&&!Array.isArray(c)&&c.treatment==null
    &&Object.keys(c).every(k=>['presentation','track','card','backdrop','interpolation','treatment'].includes(k))
    &&c.track&&typeof c.track==='object'&&!Array.isArray(c.track)
    &&Object.keys(c.track).length>0&&Object.keys(c.track).length<=9
    &&Object.values(c.track).every(s=>Array.isArray(s)&&s.length>0&&s.length<=1440
      &&s.every(v=>Number.isFinite(v)&&Math.abs(v)<=10000));
}
export function wrapHomeCamera(original,{getContext,enabled,makeRequest,runCli,runRecovery,
  runNativeContext,validScope,record=()=>{},stats}){
  return async function(request){
    const lease=getContext()?.leases?.get('ffmpeg'),scope=lease?.boosted;
    if(scope?.kind!=='video-trim')return original.call(this,request);
    const check=()=>{if(lease.signal?.aborted)throw lease.signal.reason||Error('Cancelled');
      if(!validScope(scope))throw Error('Home camera scope expired');};
    check();
    let body;
    if(enabled()&&!request.treatmentPlan&&!request.checkpoint?.remoteTask){
      try{body=makeRequest(request);}catch{}
    }
    if(cameraRequestAllowed(body)){
      scope.candidate=false;stats.attempted++;
      try{
        const result=await runCli({...request,render:body},lease.signal,scope);
        check();
        if(result?.offloaded===true&&result.verified===true){
          stats.gpu++;try{record(scope,request);}catch{}
          return {targetPath:request.targetPath,treatmentStatus:null};
        }
      }catch(error){check();if(error?.name==='AbortError')throw error;}
    }
    check();stats.fallback++;
    return runRecovery(scope,()=>runNativeContext(scope,()=>original.call(this,request)),lease.signal);
  };
}
export function installHomeCamera(d){
  if(globalThis.__vfHomeCamera)return globalThis.__vfHomeCamera;
  if(!Array.isArray(d.getState()?.waiters)||typeof d.getRender()!=='function'
    ||typeof d.scheduler?.run!=='function'||typeof d.getSlotMeasurer()!=='function')throw Error('Camera native dependencies');
  const stats={attempted:0,gpu:0,fallback:0,tagged:0,pendingTagged:0};
  const matches=fn=>CAMERA_CALLBACK_HASHES.has(d.hash(String(fn)));
  const sampler=d.getSlotMeasurer();
  d.setSlotMeasurer(function(request){
    const sample=sampler?.call(this,request);
    if(request?.resourceKey!=='ffmpegHome')return sample;
    return {run(callback){
      const scope=d.getContext()?.leases?.get('ffmpeg')?.boosted;
      if(scope?.candidate&&scope.kind==='video-normalize'&&matches(callback))scope.kind='video-trim';
      return sample?.run?sample.run(callback):callback();
    },finish(...args){return sample?.finish?.(...args);}};
  });
  d.setRender(wrapHomeCamera(d.getRender(),{...d,stats}));
  const run=d.scheduler.run;
  d.scheduler.run=function(job,resource,callback,options){
    if(resource==='ffmpeg'&&d.enabled()&&matches(callback)){
      stats.tagged++;options={...options,homeKind:'video-normalize-candidate'};
    }
    return run.call(this,job,resource,callback,options);
  };
  for(const w of d.getState().waiters){
    if(w.resourceKey==='ffmpeg'&&w.opKey==='b_roll_image'&&!w.homeKind){
      w.homeKind='video-normalize-candidate';stats.pendingTagged++;
    }
  }
  return globalThis.__vfHomeCamera={version:1,stats,activatedAt:new Date().toISOString()};
}
