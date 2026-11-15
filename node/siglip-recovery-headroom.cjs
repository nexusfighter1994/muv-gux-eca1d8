'use strict';
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');
// vf-custom:siglip-candidate-cap-v1 (2026-11-13): the limit of 2 unconfirmed Home candidates starved the
// Home GPU (2 in preparation of 8 slots, 450 waiting, ~38 ranks/min; with 4: 124/min, queue gone in 4 min).
// Runtime value: /data/runtime/vf-siglip-candidate-cap.json {"cap":4}, 1-12; missing or invalid = 2.
const CANDIDATE_CAP_FILE=process.env.VF_SIGLIP_CANDIDATE_CAP_FILE||'/data/runtime/vf-siglip-candidate-cap.json';
function createCandidateCap({file=CANDIDATE_CAP_FILE,now=Date.now,read=path=>fs.readFileSync(path,'utf8')}={}) {
  let checked=-Infinity,cap=2;
  return ()=>{
    const time=now();
    if(time-checked>=1000){
      checked=time;
      try{const value=JSON.parse(read(file)).cap;cap=Number.isInteger(value)&&value>=1&&value<=12?value:2;}catch{cap=2;}
    }
    return cap;
  };
}

// Allow two full 25-request recovery waves without occupying new Home places.
// Total contexts stay capped at 75; native permits remain six, server cap unchanged.
const RECOVERY_HEADROOM=50;
function install(queue,{getState,getCapacity,claim,scopes,isAborted=()=>false,newNonce=randomUUID}) {
  if(queue.__vfRecoveryHeadroom?.version===3)return queue;
  if(!(scopes instanceof Map))throw Error('SigLIP scope registry required');
  const originalDrain=queue.drain,originalStats=queue.stats;
  let draining=false,admitted=0;
  const candidateCap=createCandidateCap();
  const capacity=()=>Math.max(0,Math.min(25,Number(getCapacity())||0));
  const homeScopes=()=>[...scopes.values()].filter(s=>!s.recovering);
  const candidates=()=>homeScopes().filter(s=>s.candidate).length;
  const eligible=w=>w.resourceKey==='siglip'&&['siglip-home','siglip-home-candidate'].includes(w.homeKind)
    &&!isAborted(w.jobId)&&!w.signal?.aborted;
  queue.drain=function(){
    if(draining)return;
    draining=true;
    try {
      while(homeScopes().length<capacity()&&scopes.size<capacity()+RECOVERY_HEADROOM) {
        const w=getState().waiters.filter(eligible)
          .filter(w=>w.homeKind!=='siglip-home-candidate'||candidates()<candidateCap())
          .sort((a,b)=>a.priority<b.priority?-1:a.priority>b.priority?1:a.seq-b.seq)[0];
        if(!w)break;
        const scope={jobId:w.jobId,nonce:newNonce(),kind:'siglip-embed',resourceKey:'siglip',
          candidate:w.homeKind==='siglip-home-candidate',signal:w.signal,opKey:w.opKey,quality:w.quality};
        scopes.set(scope.nonce,scope);
        try{claim(w,scope);admitted++;}catch(error){scopes.delete(scope.nonce);throw error;}
      }
    } finally {draining=false;}
  };
  queue.stats=function(){
    const value=originalStats.call(this),home=homeScopes();
    return {...value,admitted:value.admitted+admitted,homeActive:home.length,
      candidateActive:candidates(),preparing:home.filter(s=>!s.pcSubmitted).length,
      recoveryHeadroom:RECOVERY_HEADROOM,totalCapacity:capacity()+RECOVERY_HEADROOM,candidateCap:candidateCap()};
  };
  queue.__vfRecoveryHeadroom={version:3,originalDrain,originalStats};
  return queue;
}
module.exports={RECOVERY_HEADROOM,install,createCandidateCap};
