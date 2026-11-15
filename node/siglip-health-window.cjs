'use strict';
const {READY_MS}=require('./siglip-native-cap.cjs');
function capacity({health,checkedAt,config,submitted=0,now=Date.now()}){
  if(config?.enabled!==true||config.siglipEnabled!==true||!Number.isSafeInteger(config.siglipConcurrency)||
    health?.ready!==true||health.device!=='cuda'||health.model_id!=='google/siglip2-base-patch16-384'||
    health.model_revision!=='f775b65a79762255128c981547af89addcfe0f88'||health.multi_query!==true||
    !Number.isSafeInteger(health.configured_concurrency)||!Number.isFinite(checkedAt)||checkedAt<=0||now<checkedAt||now-checkedAt>=READY_MS)return 0;
  const external=Math.max(0,(Number(health.active_tasks)||0)-submitted);
  return Math.max(0,Math.min(25,config.siglipConcurrency,health.configured_concurrency)-external);
}
function install(health,{readConfig,submitted=()=>globalThis.__vfHomeSiglipQueue?.statsSubmitted?.()||0,now=Date.now}){
  const previous=health.__vfWindow102;
  if(previous?.readyMs===READY_MS)return previous;
  if(typeof health.snapshot!=='function'||typeof health.getCapacity!=='function')throw Error('Unexpected health interface');
  const original=health.getCapacity;
  const wrapped=()=>{try{return capacity({...health.snapshot(),config:readConfig(),submitted:submitted(),now:now()});}catch{return 0;}};
  const handle={at:new Date().toISOString(),readyMs:READY_MS,restore(){
    if(health.getCapacity!==wrapped)throw Error('Health ownership changed');
    health.getCapacity=original;
    if(previous)health.__vfWindow102=previous;else delete health.__vfWindow102;
  }};
  health.getCapacity=wrapped;health.__vfWindow102=handle;return handle;
}
module.exports={capacity,install};
