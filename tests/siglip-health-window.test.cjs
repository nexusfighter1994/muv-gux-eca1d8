const test=require('node:test'),assert=require('node:assert/strict');
const {capacity,install}=require('../node/siglip-health-window.cjs');
const h={ready:true,device:'cuda',model_id:'google/siglip2-base-patch16-384',model_revision:'f775b65a79762255128c981547af89addcfe0f88',multi_query:true,configured_concurrency:25,active_tasks:20};
const c={enabled:true,siglipEnabled:true,siglipConcurrency:25};
test('same bounded 120s window as native server cap tolerates 90s API stalls',()=>{
  assert.equal(capacity({health:h,checkedAt:1000,config:c,submitted:20,now:16000}),25);
  assert.equal(capacity({health:h,checkedAt:1000,config:c,submitted:20,now:120999}),25);
  assert.equal(capacity({health:h,checkedAt:1000,config:c,submitted:20,now:121000}),0);
});
test('disabled, invalid model, future, non-ready and missing health close admission',()=>{
  for(const health of [null,{...h,ready:false},{...h,device:'cpu'},{...h,model_revision:'wrong'}])
    assert.equal(capacity({health,checkedAt:1000,config:c,submitted:20,now:2000}),0);
  for(const config of [{...c,enabled:false},{...c,siglipEnabled:false},{...c,siglipConcurrency:NaN}])
    assert.equal(capacity({health:h,checkedAt:1000,config,submitted:20,now:2000}),0);
  assert.equal(capacity({health:h,checkedAt:1000,config:c,submitted:20,now:999}),0);
});
test('receiver capacity, external work and configured limits remain enforced',()=>{
  assert.equal(capacity({health:h,checkedAt:1000,config:c,submitted:15,now:2000}),20);
  assert.equal(capacity({health:{...h,configured_concurrency:20},checkedAt:1000,config:c,submitted:20,now:2000}),20);
});
test('hot replacement preserves original probe timer, snapshot and rollback ownership',()=>{
  let now=16000;const snapshot=()=>({health:h,checkedAt:1000}),timer={},old=()=>0;
  const health={getCapacity:old,snapshot,timer};const handle=install(health,{readConfig:()=>c,submitted:()=>20,now:()=>now});
  assert.equal(health.getCapacity(),25);assert.equal(health.snapshot,snapshot);assert.equal(health.timer,timer);
  now=121000;assert.equal(health.getCapacity(),0);handle.restore();assert.equal(health.getCapacity,old);
});
