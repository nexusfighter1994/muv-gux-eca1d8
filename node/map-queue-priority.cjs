'use strict';
function sortWaitingMaps(queue,jobs){
  if(!Array.isArray(queue)||!(jobs instanceof Map))return 0;
  const entries=[];
  for(let i=0;i<queue.length;i++){
    const entry=queue[i],priority=jobs.get(entry?.jobId)?.priority;
    if(entry?.state==='queued'&&!entry.cancelled&&typeof priority==='string')
      entries.push({index:i,entry,priority});
  }
  const sorted=[...entries].sort((a,b)=>a.priority<b.priority?-1:a.priority>b.priority?1:a.index-b.index);
  let changed=0;
  for(let i=0;i<entries.length;i++){
    const index=entries[i].index;
    if(queue[index]!==sorted[i].entry){queue[index]=sorted[i].entry;changed++;}
  }
  return changed;
}
function createMapQueuePriority({getQueue,getJobs,setTimer=setInterval,clearTimer=clearInterval}){
  if(typeof getQueue!=='function'||typeof getJobs!=='function')throw TypeError('Map queue getters required');
  const stats={version:1,ticks:0,moved:0,errors:0,at:null};
  let timer=null;
  function tick(){try{const n=sortWaitingMaps(getQueue(),getJobs());stats.ticks++;stats.moved+=n;stats.at=new Date().toISOString();return n;}catch{stats.errors++;return 0;}}
  return {stats,tick,start(){if(timer)return false;tick();timer=setTimer(tick,5000);timer?.unref?.();return true;},stop(){if(timer)clearTimer(timer);timer=null;}};
}
module.exports={sortWaitingMaps,createMapQueuePriority};
