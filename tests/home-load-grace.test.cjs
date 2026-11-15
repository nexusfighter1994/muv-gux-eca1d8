'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../node/home-load-timeouts.cjs');
const native=require('../node/siglip-native-cap.cjs');
const window=require('../node/siglip-health-window.cjs');
const ocr=require('../node/home-ocr-readiness.cjs');
const health={ready:true,device:'cuda',model_id:'google/siglip2-base-patch16-384',model_revision:'f775b65a79762255128c981547af89addcfe0f88',multi_query:true,configured_concurrency:25,active_tasks:0};
const config={enabled:true,siglipEnabled:true,siglipConcurrency:25};

test('user-requested health wait and both admission windows are bounded at 120 seconds',()=>{
  assert.equal(policy.HEALTH_MS,120000);
  assert.equal(native.READY_MS,120000);
  assert.equal(ocr.READY_MS,120000);
  assert.equal(policy.IMAGE_MS,80000);
  assert.equal(policy.SIGLIP_MS,600000);
});
test('90 second API delay retains qualified Home capacity, 120 second expiry closes it',()=>{
  assert.equal(window.capacity({health,config,checkedAt:1000,now:91000}),25);
  assert.equal(window.capacity({health,config,checkedAt:1000,now:120999}),25);
  assert.equal(window.capacity({health,config,checkedAt:1000,now:121000}),0);
  assert.equal(window.capacity({health:{...health,ready:false},config,checkedAt:1000,now:91000}),0);
});
test('old 40 second health wrapper is upgraded without changing explicit short caller deadlines',()=>{
  const seen=[],old={healthMs:40000};
  const worker={__vfLoadHealth110:old,health:options=>seen.push(options.deadlineMs)};
  const handle=policy.installWorkerHealth(worker);
  worker.health({deadlineMs:40000});worker.health({deadlineMs:5000});worker.health({deadlineMs:700});
  assert.deepEqual(seen,[120000,120000,700]);
  handle.restore();assert.equal(worker.__vfLoadHealth110,old);
});
