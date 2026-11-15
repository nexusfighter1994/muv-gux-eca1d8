'use strict';
const BASE_MS=1800000,MAX_MS=3600000;
const STEPS=['downloading','probing','preparing_segments','concatenating','mixing_audio',
  'applying_effects','finalizing','cleaning_up'];
const counters={admitted:0,extendedPast30m:0,completedAfter30m:0,stalled:0};
const active=new Map();

// Live installation wraps the existing recovery functions without replacing their
// async-local ownership state or touching already-running polls.
function createHotBridge({getContext,validScope,isNativeRecovery,report=()=>{}}){
  const context=new (require('node:async_hooks').AsyncLocalStorage)();
  return {
    wrapChunk(original){
      if(original.__vfChunkBudget)return original;
      return Object.assign(function(args){return context.run({jobId:args.jobId},()=>original.call(this,args));},
        {__vfChunkBudget:true});
    },
    wrapPoll(original){
      if(original.__vfChunkBudget)return original;
      return Object.assign(async function(options={}){
        const chunk=context.getStore();
        const budget=createBudget(options,{chunk:chunk?{...chunk,native:isNativeRecovery()}:null,
          scope:getContext()?.leases?.get('ffmpeg')?.boosted,validScope,report});
        let last;
        try{return await original.call(this,{...budget.options,
          fetchStatus:async()=>{last=await options.fetchStatus();return last;}});}
        finally{budget.finish(last);}
      },{__vfChunkBudget:true});
    },
  };
}

function createBudget(options,{chunk,scope,validScope,now=Date.now,report=()=>{}}){
  if(options.engine!=='fflow'||options.timeoutMs!==BASE_MS||!chunk||chunk.native
      ||scope?.kind!=='composition'||scope.jobId!==chunk.jobId||!validScope(scope))
    return {options,finish(){}};
  const started=now(),key=Symbol(),entry={jobId:chunk.jobId,remoteJobId:options.remoteJobId,
    startedAt:started,deadline:started+MAX_MS,lastProgressAt:started,progress:null,step:null};
  let initialized=false,maxProgress=-1,maxStep=-1,extended=false,finished=false;
  counters.admitted++;active.set(key,entry);
  return {
    options:{...options,timeoutMs:MAX_MS,onTick(value){
      options.onTick?.(value);
      const data=value?.data||value;
      if(['completed','failed','cancelled'].includes(data?.status))return;
      const at=now(),progress=data?.progress,step=STEPS.indexOf(data?.current_step);
      const numeric=typeof progress==='number'&&Number.isFinite(progress)&&progress>=0&&progress<=100;
      // Only forward render progress counts; timestamps, heartbeats and repeated stages do not.
      if(initialized&&((numeric&&progress>maxProgress)||step>maxStep))entry.lastProgressAt=at;
      initialized=true;
      if(numeric)maxProgress=Math.max(maxProgress,progress);
      maxStep=Math.max(maxStep,step);entry.progress=maxProgress;entry.step=data?.current_step||null;
      if(at-entry.lastProgressAt>=BASE_MS){
        counters.stalled++;
        throw Object.assign(Error(`pollJob: timed out after ${BASE_MS}ms without render progress (Home chunk)`),
          {timedOut:true,status:value,vfHomeStalled:true});
      }
      if(!extended&&at-started>=BASE_MS){
        extended=true;counters.extendedPast30m++;
        report('Home chunk continuing with progress; 60min absolute limit',options.remoteJobId);
      }
    }},
    finish(value){
      if(finished)return;finished=true;active.delete(key);
      if(now()-started>=BASE_MS&&(value?.data||value)?.status==='completed')counters.completedAfter30m++;
    },
  };
}

function stats(){return {version:1,baseMs:BASE_MS,maxMs:MAX_MS,idleMs:BASE_MS,...counters,
  active:[...active.values()].map(x=>({...x}))};}
globalThis.__vfHomeChunkBudget={stats};
module.exports={createBudget,createHotBridge,stats,BASE_MS,MAX_MS};
