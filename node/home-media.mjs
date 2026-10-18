const POLICY='nvenc-high-qp14-v1';

export function mediaRequestFromCommand({command,timeoutMs=120000},classify){
  if(!Array.isArray(command)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)return null;
  const args=command.slice(1),prefix=['-y','-hide_banner','-loglevel','error'];
  if(!prefix.every((v,i)=>args[i]===v))return null;
  args.splice(0,prefix.length);
  if(args[0]==='-threads'){
    if(!['-threads','-filter_threads','-filter_complex_threads'].every((v,i)=>
      args[i*2]===v&&/^(?:[1-9]|1[0-6])$/.test(args[i*2+1])))return null;
    args.splice(0,6);
  }
  return classify(args)?{argv:args,options:{timeoutMs}}:null;
}

export function wrapHomeMediaExec(original,{getContext,getBinary,qualify,runCli,runRecovery,
  runNativeContext,report=()=>{},stats={attempted:0,gpu:0,fallback:0}}={}){
  if(typeof runNativeContext!=='function')throw new TypeError('runNativeContext is required');
  if(original.__vfHomeMedia)return original;
  const wrapped=async function(binary,args,options={}){
    const scope=getContext()?.leases?.get('ffmpeg')?.boosted;
    if(scope?.kind!=='video-trim'||binary!==getBinary())return original.call(this,binary,args,options);
    const abort=()=>{if(options.signal?.aborted)throw options.signal.reason||Object.assign(Error('Cancelled'),{name:'AbortError'});};
    abort();
    let request=null;
    try{request=qualify({command:[binary,...args],timeoutMs:options.timeoutMs||120000});}catch{}
    if(request){
      stats.attempted++;
      try{
        const result=await runCli(request,options);
        abort();
        if(result?.offloaded===true&&result.metadata?.verified===true
            &&result.metadata.lane==='gpu'&&result.metadata.gpuPolicy===POLICY){
          stats.gpu++;return {stdout:'Home PC GPU output verified',stderr:''};
        }
      }catch(error){
        abort();
        if(error?.name==='AbortError')throw error;
        report('home-media-deferred',error?.name||'Error');
      }
    }
    abort();stats.fallback++;
    return runRecovery(scope,()=>runNativeContext(scope,()=>original.call(this,binary,args,options)),options.signal);
  };
  wrapped.__vfHomeMedia=true;
  return wrapped;
}

export function installHomeMedia({scheduler,getExec,setExec,getContext,getBinary,runCli,
  runRecovery,runNativeContext,classifyCallback,classifyArgv,enabled=()=>true,report=()=>{}}){
  const existing=globalThis.__vfHomeMedia;
  if(existing?.version>=2)return existing;
  if(!scheduler||typeof scheduler.run!=='function'||![getExec,setExec,getContext,getBinary,runCli,
    runRecovery,runNativeContext,classifyCallback,classifyArgv,enabled,report].every(x=>typeof x==='function'))
    throw new TypeError('Home media dependencies required');
  const stats=existing?.stats||{attempted:0,gpu:0,fallback:0,tagged:0};
  const native=scheduler.run;
  if(!existing)scheduler.run=function(job,resource,callback,options){
    const kind=enabled()&&resource==='ffmpeg'&&classifyCallback(callback);
    // Reuse the existing direct-transform lease so old samplers remain compatible hot.
    // The separate CLI validates the recipe again before any Home request is sent.
    if(kind){stats.tagged++;options={...options,homeKind:'video-trim',operation:options?.operation||'home-media-'+kind};}
    return native.call(this,job,resource,callback,options);
  };
  const previous=getExec();
  // A v1 hot upgrade keeps its scheduler and in-flight calls. Native recovery
  // masks the Home scope before delegating, so the old executor cannot offload twice.
  const base=existing?function(...args){return previous.apply(this,args);}:previous;
  setExec(wrapHomeMediaExec(base,{getContext,getBinary,runCli,runRecovery,runNativeContext,report,stats,
    qualify:payload=>enabled()?mediaRequestFromCommand(payload,classifyArgv):null}));
  return (globalThis.__vfHomeMedia={...existing,stats,version:2});
}
