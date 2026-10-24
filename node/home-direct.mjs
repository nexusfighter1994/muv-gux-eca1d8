export function isHomeDirectCallback(callback){
  const source=String(callback);
  if([
    '()=>u(["-y","-i",e,"-vf",h,"-map","0:v:0","-map","0:a?","-c:v","libx264",...x3(),"-pix_fmt","yuv420p","-r","24","-c:a","aac","-b:a","192k","-t",p.toFixed(3),"-movflags","+faststart","-f","mp4",t],{timeoutMs:18e4})',
    '()=>a(["-y","-i",e,"-vf",r,"-map","0:v:0","-map","0:a?","-c:v","libx264",...x3(),"-pix_fmt","yuv420p","-r","24","-c:a","aac","-b:a","192k","-t",c.toFixed(3),"-movflags","+faststart",t],{timeoutMs:18e4})',
  ].includes(source))return true;
  return /^\(\)=>[a-zA-Z_$][\w$]*\(\["-y","-i",e,"-vf",[rh],/.test(source)
    &&['TL','QL'].some(threads=>source.includes('"-map","0:v:0","-map","0:a?","-c:v","libx264",...'+threads+'(),"-pix_fmt","yuv420p","-r","24","-c:a","aac","-b:a","192k","-t",'))
    &&/,[pl]\.toFixed\(3\),"-movflags","\+faststart",t\],\{timeoutMs:18e4\}\)$/.test(source);
}

export function guardHomeDirectCallback(callback,scope,runRecovery,signal,runNativeContext){
  if(scope?.kind!=='video-normalize'||isHomeDirectCallback(callback))return callback;
  if(typeof runNativeContext!=='function')throw new TypeError('runNativeContext is required');
  // Retain the counted outer permit while masking only its inherited Home scope.
  return ()=>runRecovery(scope,()=>runNativeContext(scope,callback),signal);
}

export function confirmHomeCandidate(scope,callback){
  if(scope?.candidate&&scope.kind==='video-normalize'&&isHomeDirectCallback(callback)){
    scope.candidate=false;return true;
  }
  return false;
}

export function markPendingHomeCandidates(state,limit=Infinity){
  let marked=0;
  for(const waiter of state.waiters){
    if(marked>=limit)break;
    if(waiter.resourceKey!=='ffmpeg'||waiter.homeKind||waiter.opKey!=='b_roll_video')continue;
    waiter.homeKind='video-normalize-candidate';marked++;
  }
  return marked;
}

export function installHomeDirect({scheduler,getSlotMeasurer,setSlotMeasurer,getContext,runRecovery,runNativeContext}){
  if(scheduler.run.__vfHomeDirect)return;
  if(typeof runNativeContext!=='function')throw new TypeError('runNativeContext is required');
  const originalSampler=getSlotMeasurer();
  setSlotMeasurer(function(request){
    if(request?.resourceKey!=='ffmpegHome')return originalSampler?.call(this,request);
    let sample=null;
    try{sample=originalSampler?.call(this,request);}catch{}
    return {
      run(callback){
        const lease=getContext()?.leases?.get('ffmpeg');
        confirmHomeCandidate(lease?.boosted,callback);
        const guarded=guardHomeDirectCallback(callback,lease?.boosted,runRecovery,lease?.signal,runNativeContext);
        return typeof sample?.run==='function'?sample.run(guarded):guarded();
      },
      finish(...args){return sample?.finish?.(...args);},
    };
  });
  const originalRun=scheduler.run;
  const run=function(jobId,resource,callback,options){
    if(resource==='ffmpeg'&&isHomeDirectCallback(callback))
      options={...options,homeKind:'video-normalize',operation:options?.operation||'home-credit-render'};
    return originalRun.call(this,jobId,resource,callback,options);
  };
  run.__vfHomeDirect=true;
  scheduler.run=run;
}
