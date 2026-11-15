'use strict';
// vf-custom:image-ms-180-v1 (2026-11-12, owner: generous timeouts): SigLIP image transport 80 -> 180 s.
const HEALTH_MS=120000,IMAGE_MS=180000,SIGLIP_MS=600000;

// Only the known production health deadlines are upgraded, never config writes
// or another caller's explicitly shorter cancellation/deadline contract.
function installWorkerHealth(workers){
  if(workers.__vfLoadHealth110?.healthMs===HEALTH_MS)return workers.__vfLoadHealth110;
  if(typeof workers.health!=='function')throw Error('Missing Home health client');
  const original=workers.health,previous=workers.__vfLoadHealth110;
  const wrapped=function(options={}){
    return original.call(this,[5000,24000,40000].includes(options.deadlineMs)?{...options,deadlineMs:HEALTH_MS}:options);
  };
  const handle={healthMs:HEALTH_MS,restore(){
    if(workers.health!==wrapped)throw Error('Home health ownership changed');
    workers.health=original;
    if(previous)workers.__vfLoadHealth110=previous;else delete workers.__vfLoadHealth110;
  }};
  workers.health=wrapped;workers.__vfLoadHealth110=handle;return handle;
}
module.exports={HEALTH_MS,IMAGE_MS,SIGLIP_MS,installWorkerHealth};
