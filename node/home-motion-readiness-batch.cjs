'use strict';
const installed=new WeakMap();
function install(queue,validation){
  if(installed.has(queue))return installed.get(queue);
  if(!queue||!validation||['stats','drain'].some(k=>typeof queue[k]!=='function')||typeof validation.ready!=='function')
    throw Error('Motion readiness dependencies missing');
  const ready=validation.ready,original={stats:queue.stats,drain:queue.drain};
  const stats={reads:0,saved:0};let depth=0,hasValue=false,value;
  const wrappedReady=function(...args){
    if(!depth)return ready.apply(this,args);
    if(hasValue){stats.saved++;return value;}
    value=ready.apply(this,args);hasValue=true;stats.reads++;return value;
  };
  const wrapped={};
  for(const key of ['stats','drain']){
    wrapped[key]=function(...args){
      depth++;
      // No TTL: a scan shares readiness only until this synchronous call returns.
      try{return original[key].apply(this,args);}
      finally{if(--depth===0){hasValue=false;value=undefined;}}
    };
    queue[key]=wrapped[key];
  }
  validation.ready=wrappedReady;
  const handle={version:1,stats,restore(){
    for(const key of ['stats','drain'])if(queue[key]===wrapped[key])queue[key]=original[key];
    if(validation.ready===wrappedReady)validation.ready=ready;
    installed.delete(queue);
  }};
  installed.set(queue,handle);return handle;
}
module.exports={install};
