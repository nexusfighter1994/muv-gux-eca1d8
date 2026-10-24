'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const installed=new WeakMap();
function install({queue,scheduler,getState,getContext}){
  if(installed.has(queue))return installed.get(queue);
  const parent=new AsyncLocalStorage(),native=queue.native,run=scheduler.run;
  const stats={reordered:0,last:null};
  queue.native=function(...args){
    const scope=getContext()?.leases?.get('render')?.boosted;
    return queue.valid(scope)?parent.run(scope,()=>native.apply(this,args)):native.apply(this,args);
  };
  const wrapped=function(jobId,resource,callback,options){
    const scope=parent.getStore();
    if(resource!=='frameshift'||options?.homeKind!=='motion-native-recovery'||!queue.valid(scope)
      ||!Number.isSafeInteger(scope.seq)||scope.seq<0)return run.apply(this,arguments);
    const before=new Set(getState().waiters);
    const result=run.apply(this,arguments);
    // Native acquisition enqueues synchronously. Only this request inherits FIFO age;
    // its current job priority, cancellation, RAM admission and deadline stay native.
    for(const w of getState().waiters){
      if(before.has(w)||w.jobId!==jobId||w.homeKind!=='motion-native-recovery')continue;
      const previous=w.seq;w.seq=Math.min(w.seq,scope.seq);
      if(w.seq<previous){stats.reordered++;stats.last={jobId,previous,seq:w.seq,at:new Date().toISOString()};}
    }
    return result;
  };
  Object.assign(wrapped,run);scheduler.run=wrapped;
  const result={stats:()=>({...stats,last:stats.last?{...stats.last}:null})};
  queue.recoveryOrderStats=result.stats;installed.set(queue,result);return result;
}
module.exports={install};
