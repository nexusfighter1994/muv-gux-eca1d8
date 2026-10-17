export function canHomeNormalizeFilter(filter){
  return /^(?:crop=[1-9][0-9]{0,4}:[1-9][0-9]{0,4}:[0-9]{1,5}:[0-9]{1,5},)?scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080$/.test(filter);
}

export function nativeNormalizeRequest({command,timeoutMs}){
  if(!Array.isArray(command)||timeoutMs!==180000)return null;
  const argv=command.slice(1),prefix=['-y','-hide_banner','-loglevel','error'];
  if(!prefix.every((value,index)=>argv[index]===value))return null;
  argv.splice(0,prefix.length);
  if(argv[0]==='-threads'){
    const keys=['-threads','-filter_threads','-filter_complex_threads'];
    if(!keys.every((key,index)=>argv[index*2]===key&&/^[1-9][0-9]?$/.test(argv[index*2+1])))return null;
    argv.splice(0,6);
  }
  return {argv,options:{timeoutMs}};
}

export function wrapHomeNormalizeExec(original,{getContext,getBinary,runCli,runRecovery,
  report=()=>{}}){
  if(original.__vfHomeNormalize)return original;
  const wrapped=async function(binary,args,options={}){
    const scope=getContext()?.leases?.get('ffmpeg')?.boosted;
    if(scope?.kind!=='video-normalize'||binary!==getBinary())
      return original.call(this,binary,args,options);
    let remote=false;
    try{
      const result=await runCli({command:[binary,...args],timeoutMs:options.timeoutMs||180000},options);
      remote=result?.offloaded===true;
    }catch(error){
      if(options.signal?.aborted||error?.name==='AbortError')throw error;
      report('normalize-offload-deferred',error?.name||'Error');
    }
    if(remote)return {stdout:'Home PC output verified',stderr:''};
    return runRecovery(scope,()=>original.call(this,binary,args,options),options.signal);
  };
  wrapped.__vfHomeNormalize=true;
  return wrapped;
}
