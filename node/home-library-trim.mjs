export function isHomeLibraryTrimCallback(callback){
  return [
    'async()=>{let ro=await Y4t({sourceUrl:Lr.entry.sourceUrl});return zn({sourceUrl:ro,localVideoUrl:ro,videoFps:Lr.entry.videoFps,startSec:Lr.start_sec,endSec:Lr.end_sec,targetPath:Ck.join(Vr,`library-${Lr.shot_id}.mp4`),deadlineTs:Date.now()+Tp})}',
    '()=>Yn({sourceUrl:jr.entry.sourceUrl,localVideoUrl:jr.entry.sourceUrl,videoFps:jr.entry.videoFps,startSec:jr.start_sec,endSec:jr.end_sec,targetPath:AS.join(Wr,`library-${jr.shot_id}.mp4`),deadlineTs:Date.now()+lp})',
    '()=>Un({sourceUrl:$r.entry.sourceUrl,localVideoUrl:$r.entry.sourceUrl,videoFps:$r.entry.videoFps,startSec:$r.start_sec,endSec:$r.end_sec,targetPath:RS.join(qr,`library-${$r.shot_id}.mp4`),deadlineTs:Date.now()+up})',
  ].includes(String(callback));
}

export function installHomeLibraryTrim({scheduler,getSlotMeasurer,setSlotMeasurer,getContext}){
  if(scheduler.run.__vfHomeLibraryTrim)return;
  const originalSampler=getSlotMeasurer();
  setSlotMeasurer(function(request){
    const sample=originalSampler?.call(this,request);
    if(request?.resourceKey!=='ffmpegHome')return sample;
    return {
      run(callback){
        const scope=getContext()?.leases?.get('ffmpeg')?.boosted;
        if(scope?.candidate&&scope.kind==='video-normalize'&&isHomeLibraryTrimCallback(callback)){
          // The original FFlow trim protocol owns its output, lease and recovery.
          scope.kind='video-trim';scope.candidate=false;
        }
        if(typeof sample?.run!=='function')throw Error('Original Home sampler unavailable');
        return sample.run(callback);
      },
      finish(...args){return sample?.finish?.(...args);},
    };
  });
  const originalRun=scheduler.run;
  const run=function(jobId,resource,callback,options){
    if(resource==='ffmpeg'&&isHomeLibraryTrimCallback(callback))
      options={...options,homeKind:'video-trim',operation:options?.operation||'home-library-trim'};
    return originalRun.call(this,jobId,resource,callback,options);
  };
  run.__vfHomeLibraryTrim=true;run.__vfHomeDirect=originalRun.__vfHomeDirect;
  scheduler.run=run;
}
