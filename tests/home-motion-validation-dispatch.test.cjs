const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=require('../node/home-motion-dispatch.cjs');
const validation=require('../node/home-motion-validation.cjs');
test('two qualified validation scopes maximum, renders continue, no unknown callbacks',()=>{
  const state={waiters:[]},claimed=[];let ready=true;
  globalThis.__vfHomeMotionValidation={ready:()=>ready};
  const q=api.createQueue({getState:()=>state,getCapacity:()=>4,available:()=>20000,
    claim(w,s){state.waiters.splice(state.waiters.indexOf(w),1);claimed.push(s);}});
  for(let n=0;n<4;n++)state.waiters.push({jobId:'v'+n,resourceKey:'frameshift',homeKind:'motion-validation',priority:0,seq:n});
  state.waiters.push({jobId:'render',resourceKey:'frameshift',homeKind:'motion-home',priority:1,seq:5});
  q.drain();assert.deepEqual(claimed.map(s=>s.jobId),['v0','v1','render']);
  assert.equal(q.stats().validationActive,2);
  q.release(claimed[0],true);ready=false;q.drain();assert.equal(claimed.length,3);
  ready=true;q.drain();assert.equal(claimed.length,4);
  for(const source of validation.CALLBACKS)assert.equal(api.renderOnly({toString:()=>source},false),true);
  assert.equal(api.renderOnly(()=>unknown.validateComposition()),false);
  delete globalThis.__vfHomeMotionValidation;
});
