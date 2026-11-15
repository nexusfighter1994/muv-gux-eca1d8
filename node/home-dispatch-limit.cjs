'use strict';
const fs = require('node:fs');
const FILE = '/data/runtime/pc-home-dispatch-limit.json';
const valid = value => Number.isInteger(value) && value >= 0 && value <= 50;

function createLimitReader({file=FILE,now=Date.now}={}) {
  let checked=-Infinity, slots=0;
  return () => {
    const time=now();
    if(time-checked>=1000) {
      checked=time;
      try { const value=JSON.parse(fs.readFileSync(file,'utf8')).slots; slots=valid(value)?value:0; }
      catch { slots=0; }
    }
    return slots;
  };
}
const readLimit=createLimitReader();
// Scopes waiting in a server recovery permit (home-queue.mjs) do not run on the PC. On 2026-11-05
// 18 of 39 scopes sat there while the Home encoders idled (6/18 CPU, 3/14 GPU), so each pending
// recovery adds one dispatch slot on top of the configured Home limit (bounded).
const MAX_RECOVERY_EXTRA=24;
function recoveryPending(items=globalThis.__vfHomeRecoveryItems) {
  if(!(items instanceof Map))return 0;
  let pending=0;
  for(const item of items.values())if(!item?.controller?.signal?.aborted)pending++;
  return Math.min(MAX_RECOVERY_EXTRA,pending);
}
// Recoveries that WAIT for one of the server's 6 recovery slots mean Home got more than it could run
// (the hook falls back when Home's CPU and GPU slots are full). Then each waiting recovery removes a
// dispatch slot instead of adding one (2026-11-05 21:47: +1 per recovery parked 32 trims). Running
// recoveries (Home dropped work, e.g. after a restart) still add their slot back.
function recoveryAdjustment(items=globalThis.__vfHomeRecoveryItems) {
  if(!(items instanceof Map))return 0;
  let running=0,waiting=0;
  for(const item of items.values()){
    if(item?.controller?.signal?.aborted)continue;
    if(item.started)running++;else waiting++;
  }
  return waiting>0?-Math.min(MAX_RECOVERY_EXTRA,waiting):Math.min(MAX_RECOVERY_EXTRA,running);
}
// A Home job spends most of its slot time in transfer (2026-11-05 21:55: 27 dispatched, only 2-5
// running), so Home gets up to 2x its run slots in flight. More than that only made the FFlow hook
// send work back to the server (Home CPU and GPU slots full); recoveryAdjustment() brakes that case.
const PREFETCH=2;
function rawDispatchCapacity(health,slots=0,now=Date.now(),extra=recoveryAdjustment()) {
  const capacity=Number(health?.capacity);
  if(!health?.ready || !Number.isFinite(capacity) || capacity<=0
    || !Number.isFinite(health.checkedAt) || now-health.checkedAt>=45000) return 0;
  const runnable=Math.max(1,Math.floor(capacity*PREFETCH));
  return Math.max(1,Math.min(50,valid(slots)&&slots>0?slots:Math.floor(capacity),runnable)+extra);
}

// Stall breaker (2026-11-05 19:10-19:50 UTC): a connected but stalled Home PC held all 50 dispatch
// slots and released almost nothing, so the server waited on claimed work (14-59 segments/10 min,
// vs ~100 with Home gone and ~105 with Home healthy). When the full Home queue releases no slot for
// stallMs while work waits, Home gets no NEW work for cooldownMs and the server lanes take it;
// in-flight Home work keeps running or recovers natively. Owner: Home must help, never slow down.
const STALL_MS=5*60e3, COOLDOWN_MS=5*60e3, SAMPLE_MS=5000;
function createStallBreaker({stats=()=>globalThis.__vfHomeQueue?.stats?.(),now=Date.now,log=m=>console.warn(m),
  stallMs=STALL_MS,cooldownMs=COOLDOWN_MS,sampleMs=SAMPLE_MS}={}) {
  const state={version:'home-stall-breaker-v1',open:false,until:0,trips:0,lastTripAt:null,
    lastAdmitted:null,progressAt:now(),sampledAt:-Infinity};
  let sampling=false;
  function sample(t) {
    if(sampling||(t-state.sampledAt<sampleMs&&t>=state.sampledAt))return;
    sampling=true;state.sampledAt=t;
    let s=null;
    try{s=stats();}catch{s=null;}finally{sampling=false;}
    if(!s||!Number.isFinite(s.admitted))return;
    if(state.lastAdmitted===null||s.admitted!==state.lastAdmitted){state.lastAdmitted=s.admitted;state.progressAt=t;return;}
    const full=s.capacity>0&&s.active>=Math.max(1,Math.floor(s.capacity*0.8));
    if(!full||!(s.queued>0)){state.progressAt=t;return;}
    if(t-state.progressAt>=stallMs){
      state.open=true;state.until=t+cooldownMs;state.trips++;state.lastTripAt=new Date(t).toISOString();
      log(`[vf-home-breaker] Home released no slot for ${Math.round((t-state.progressAt)/1000)} s (${s.active}/${s.capacity} held, ${s.queued} waiting); no new Home work for ${Math.round(cooldownMs/60e3)} min`);
    }
  }
  return {state,allow(){
    const t=now();
    if(state.open){
      if(t<state.until&&t>=state.until-cooldownMs)return false;
      state.open=false;state.progressAt=t;state.lastAdmitted=null;
    }
    sample(t);
    return !state.open;
  }};
}
const breaker=createStallBreaker();
function guardBreaker(capacity,{breaker:b=breaker}={}) {
  if(capacity?.__vfHomeBreaker)return capacity;
  const guarded=function(...args){const value=capacity.apply(this,args);return value>0&&!b.allow()?0:value;};
  guarded.__vfHomeBreaker=b.state.version;guarded.original=capacity;guarded.breaker=b;
  return guarded;
}
const dispatchCapacity=guardBreaker(rawDispatchCapacity);
globalThis.__vfHomeBreaker=breaker.state;

// Existing queues keep their closures and in-flight scopes. Only their healthy
// capacity view changes; the original probe's setter and freshness are retained.
function installHotDispatchLimit({target=globalThis,readLimit:read=readLimit,now=Date.now}={}) {
  if(target.__vfHomeDispatchLimit)return target.__vfHomeDispatchLimit;
  const previous=Object.getOwnPropertyDescriptor(target,'__vfHomeCapabilities');
  if(previous && !previous.configurable)throw Error('Home capabilities are not configurable');
  let raw=previous?.value;
  const get=previous?.get?()=>previous.get.call(target):()=>raw;
  const set=previous?.set?value=>previous.set.call(target,value):value=>{raw=value;};
  Object.defineProperty(target,'__vfHomeCapabilities',{configurable:true,
    enumerable:previous?.enumerable??true,
    get(){const health=get();return health?{...health,capacity:dispatchCapacity(health,read(),now())}:health;},
    set,
  });
  return (target.__vfHomeDispatchLimit={version:1});
}
module.exports={dispatchCapacity,rawDispatchCapacity,createStallBreaker,guardBreaker,recoveryPending,recoveryAdjustment,
  createLimitReader,readLimit,installHotDispatchLimit,MAX_RECOVERY_EXTRA,PREFETCH};
