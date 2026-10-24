'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const chunkContext=new AsyncLocalStorage(),pollContext=new AsyncLocalStorage();
const TRANSIENT=/Native Home fallback (?:(?:POST|GET|DELETE) retry exhausted|admission (?:unavailable|timed out|failed)|permit (?:unavailable|is not active)|renewal (?:lost|stopped))/;
const terminal=status=>['failed','cancelled','completed'].includes(status);

function mayResubmit(now=Date.now()) {
  if(chunkContext.getStore())return false;
  const poll=pollContext.getStore();
  return !poll||now+60000<poll.deadline;
}

function createRecovery({getContext,validScope,isAborted,cancel,report=()=>{}}) {
  const recoverable=new WeakMap();
  const stats={nativeRetries:0,recovered:0,cancelRequested:0,cleanupFailed:0};
  const api={
    stats,
    nativeRecovery:()=>chunkContext.getStore()?.native===true,
    wrapPoll(original){
      return async function(options={}){
        if(options.engine!=='fflow')return original.apply(this,arguments);
        let last;
        const deadline=Number.isFinite(options.timeoutMs)?Date.now()+options.timeoutMs:Infinity;
        try {
          return await pollContext.run({deadline},()=>original.call(this,{...options,
            fetchStatus:async()=>{last=await options.fetchStatus();return last;}}));
        } catch(error) {
          const data=last?.data||last;
          const scope=getContext()?.leases?.get('ffmpeg')?.boosted;
          const chunk=chunkContext.getStore();
          if(chunk&&!chunk.native&&scope?.kind==='composition'&&scope.jobId===chunk.jobId&&validScope(scope)
              &&data?.status==='failed'&&TRANSIENT.test(JSON.stringify(data.error||{}))) {
            // The native worker publishes failure only after render/process cleanup.
            recoverable.set(error,chunk.jobId);
          }
          if(options.remoteJobId&&!terminal(data?.status)) {
            try {await cancel(options.remoteJobId);stats.cancelRequested++;}
            catch {stats.cleanupFailed++;report('FFlow poll cleanup request failed',options.remoteJobId);}
          }
          throw error;
        }
      };
    },
    wrapChunk(original){
      return async function(args){
        const call=()=>original.call(this,args);
        try{return await chunkContext.run({jobId:args.jobId,native:false},call);}
        catch(error){
          if(recoverable.get(error)!==args.jobId||isAborted(args.jobId))throw error;
          recoverable.delete(error);
          // Re-enter the original chunk renderer only after its Home lease has unwound.
          // Native scheduler admission occurs before the next remote job/poll is started.
          const checkpoint=args.checkpoint?{...args.checkpoint,remoteTask:null}:undefined;
          await args.checkpoint?.saveRemoteTask?.(null);
          stats.nativeRetries++;
          report('Home chunk moving to counted native recovery',args.jobId);
          const result=await chunkContext.run({jobId:args.jobId,native:true},()=>original.call(this,{...args,checkpoint}));
          stats.recovered++;
          return result;
        }
      };
    },
    wrapRun(original){
      const wrapped=function(jobId,lane,fn,options){
        if(api.nativeRecovery()&&chunkContext.getStore().jobId===jobId&&lane==='ffmpeg'&&options?.resourceKey==='fflowComposition')
          options={...options,homeKind:'native-recovery'};
        return original.call(this,jobId,lane,fn,options);
      };
      Object.assign(wrapped,original);
      return wrapped;
    },
  };
  return api;
}
module.exports={createRecovery,mayResubmit};
