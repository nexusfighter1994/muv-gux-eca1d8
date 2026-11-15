'use strict';
const READY_MS = 120000;

function install({handle,queue,getState,enabled,probe,contract,now=Date.now}) {
  const previous=handle.__vfReadinessV2;
  if(previous?.readyMs===READY_MS)return previous;
  if(!contract||![handle.probe,handle.tick,handle.snapshot,handle.disable,queue.drain,getState,enabled,probe,now]
    .every(value=>typeof value==='function'))throw Error('OCR readiness dependencies unavailable');
  const original={probe:handle.probe,tick:handle.tick,snapshot:handle.snapshot,disable:handle.disable};
  const seed=original.snapshot.call(handle);
  let health=seed.health,checkedAt=Number(seed.checkedAt)||0,probing=false,disabled=false,restored=false;
  const stats={probes:0,transportErrors:0,invalidHealth:0};
  const compatible=value=>value?.ready===true&&value.contract===contract;
  if(!compatible(health))checkedAt=0;
  const ready=()=>!disabled&&!restored&&enabled()&&compatible(health)&&checkedAt>0
    &&now()>=checkedAt&&now()-checkedAt<READY_MS;
  const wrappedProbe=async function(){
    if(probing||disabled||restored)return;
    probing=true;stats.probes++;
    try {
      const value=await probe();
      if(!compatible(value)){health=value;checkedAt=0;stats.invalidHealth++;return;}
      health=value;checkedAt=now();
    } catch(error) {
      stats.transportErrors++;
      if(/^OCR HTTP (401|403)$/.test(String(error?.message||''))||['ECONNREFUSED','ENOENT','EACCES'].includes(error?.code))checkedAt=0;
      // A transport failure cannot renew freshness; expiry still closes admission.
    } finally {probing=false;}
  };
  const wrappedTick=function(){
    const available=ready();
    for(const waiter of getState().waiters){
      if(available&&waiter.resourceKey==='siglip'&&waiter.homeKind==='siglip-server'){
        waiter.homeKind='siglip-home-candidate';waiter.__vfOcrCandidate=true;
      } else if(!available&&waiter.__vfOcrCandidate&&waiter.homeKind==='siglip-home-candidate'){
        waiter.homeKind='siglip-server';delete waiter.__vfOcrCandidate;
      }
    }
    if(available)queue.drain();
  };
  const wrappedSnapshot=function(){
    return {...original.snapshot.call(handle),ready:ready(),health,checkedAt,
      queued:getState().waiters.filter(w=>w.__vfOcrCandidate).length,
      readiness:{version:3,freshForMs:READY_MS,healthAgeMs:checkedAt?now()-checkedAt:null,...stats}};
  };
  const wrappedDisable=function(...args){disabled=true;return original.disable.apply(this,args);};
  Object.assign(handle,{probe:wrappedProbe,tick:wrappedTick,snapshot:wrappedSnapshot,disable:wrappedDisable});
  const owner={version:3,readyMs:READY_MS,stats,restore(){
    if(restored)return;restored=true;
    for(const [key,value] of Object.entries({probe:wrappedProbe,tick:wrappedTick,snapshot:wrappedSnapshot,disable:wrappedDisable}))
      if(handle[key]===value)handle[key]=original[key];
    if(handle.__vfReadinessV2===owner){if(previous)handle.__vfReadinessV2=previous;else delete handle.__vfReadinessV2;}
  }};
  handle.__vfReadinessV2=owner;
  return owner;
}

module.exports={READY_MS,install};
