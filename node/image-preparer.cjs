'use strict';

// Share this instance across senders and hot-wrapper generations.
function createImagePreparer() {
  let active=0;
  const waiting=[];
  function pump() {
    for(let i=0;i<waiting.length;) {
      const item=waiting[i];
      if(item.signal.aborted){waiting.splice(i,1);item.reject(item.signal.reason);continue;}
      let cap;
      try{cap=Math.max(1,Math.min(14,Math.floor(Number(item.readLimit())||1)));}
      catch(error){waiting.splice(i,1);item.signal.removeEventListener('abort',item.abort);item.reject(error);continue;}
      if(active>=cap){i++;continue;}
      waiting.splice(i,1);active++;item.signal.removeEventListener('abort',item.abort);
      item.resolve(()=>{active--;pump();});
    }
  }
  function acquire(readLimit,signal) {
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const item={readLimit,signal,resolve,reject};
      item.abort=()=>pump();signal.addEventListener('abort',item.abort,{once:true});
      waiting.push(item);pump();
    });
  }
  return async function prepareImages({candidates,signal,readLimit,fetchImage}) {
    const controller=new AbortController();
    const combined=AbortSignal.any([signal,controller.signal]);
    const output=new Array(candidates.length);
    let next=0,failure;
    async function worker() {
      while(next<candidates.length) {
        let release;
        try {
          combined.throwIfAborted();
          const index=next++;
          release=await acquire(readLimit,combined);
          combined.throwIfAborted();
          output[index]=await fetchImage(candidates[index],combined);
        } catch(error) {
          if(!controller.signal.aborted){failure=error;controller.abort(error);}
          return;
        } finally {release?.();}
      }
    }
    await Promise.allSettled(Array.from({length:Math.min(4,candidates.length)},worker));
    signal.throwIfAborted();
    if(controller.signal.aborted)throw failure;
    return output;
  };
}

module.exports={createImagePreparer};
