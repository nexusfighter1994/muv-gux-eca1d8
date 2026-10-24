'use strict';
function createRecorder({emit}) {
  const seen=new Set();let emitted=0,errors=0;
  return {
    record(artifact) {
      try {
        const {backend,jobId,kind,path}=artifact || {};
        if(backend!=='home'||!jobId||!['opaque','alpha','low-opaque','low-alpha'].includes(kind)
          ||typeof path!=='string'||!/^\/data\/(projects|engines\/fflow)\/[^\r\n]+\.(mp4|mov)$/.test(path)
          ||path.split('/').includes('..'))return;
        const key=jobId+':'+path;if(seen.has(key))return;
        seen.add(key);if(seen.size>2000)seen.delete(seen.values().next().value);
        const location=/\/chunk_(\d+)\/segments\/segment_(\d+)(?:\.|\/)/.exec(path);
        const where=location?` | Chunk ${Number(location[1])} segment ${Number(location[2])}`:'';
        emit({jobId,step:'chunkRender',level:'info',
          message:`(Home PC) Motion artifact verified [CPU, ${kind}]${where}`,
          data:{homeMotionArtifact:true,backend:'home-cpu',kind,outputPath:path}});
        emitted++;
      }catch{errors++;}
    },
    stats:()=>({emitted,errors,retained:seen.size}),
  };
}
function install({emit}) {
  if(typeof emit!=='function')throw Error('Native event emitter required');
  return globalThis.__vfHomeMotionEvents ||= createRecorder({emit});
}
function attachLegacyRoute(route,recorder) {
  const stats=route?.stats,key=Symbol.for('vf.homeMotionReceiptObserver');
  if(!stats||stats[key])return;
  const descriptor=Object.getOwnPropertyDescriptor(stats,'last');
  if(!descriptor?.configurable||!('value' in descriptor))throw Error('Unexpected Motion receipt descriptor');
  const snapshot=()=>Object.fromEntries(['opaque','alpha','low','pod'].map(k=>[k,Number(stats[k]?.home)||0]));
  let last=descriptor.value,before=snapshot();
  Object.defineProperty(stats,'last',{enumerable:descriptor.enumerable,configurable:true,get:()=>last,set:value=>{
    last=value;
    try{
      const next=snapshot(),kind=value?.kind,bucket=kind?.startsWith('low-')?'low':kind;
      const home=['opaque','alpha','low'].includes(bucket)&&next[bucket]-before[bucket]===1&&next.pod===before.pod;
      before=next;
      if(home)recorder.record({...value,backend:'home'});
    }catch{ /* Telemetry must never interrupt the renderer. */ }
  }});
  Object.defineProperty(stats,key,{value:true});
}
module.exports={createRecorder,install,attachLegacyRoute};
