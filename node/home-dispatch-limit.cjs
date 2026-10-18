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
function dispatchCapacity(health,slots=0,now=Date.now()) {
  const capacity=Number(health?.capacity);
  if(!health?.ready || !Number.isFinite(capacity) || capacity<=0
    || !Number.isFinite(health.checkedAt) || now-health.checkedAt>=45000) return 0;
  return Math.min(50,valid(slots)&&slots>0?slots:Math.floor(capacity));
}

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
module.exports={dispatchCapacity,createLimitReader,readLimit,installHotDispatchLimit};
