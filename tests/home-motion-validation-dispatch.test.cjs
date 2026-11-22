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
test('validation slots follow the capacity the Home worker reports (1-8), default 2',()=>{
  const run=cap=>{
    const state={waiters:[]},claimed=[];
    globalThis.__vfHomeMotionValidation={ready:()=>true,...(cap===undefined?{}:{capacity:()=>cap})};
    const q=api.createQueue({getState:()=>state,getCapacity:()=>9,available:()=>20000,
      claim(w,s){state.waiters.splice(state.waiters.indexOf(w),1);claimed.push(s);}});
    for(let n=0;n<8;n++)state.waiters.push({jobId:'v'+n,resourceKey:'frameshift',homeKind:'motion-validation',priority:0,seq:n});
    q.drain();delete globalThis.__vfHomeMotionValidation;return q.stats().validationActive;
  };
  assert.equal(run(undefined),2);assert.equal(run(4),4);assert.equal(run(9),2,'out of range falls back');
});
test('validations are still admitted while recovering scopes fill the room; renders are not',()=>{
  const state={waiters:[]},claimed=[];
  globalThis.__vfHomeMotionValidation={ready:()=>true,capacity:()=>4};
  const q=api.createQueue({getState:()=>state,getCapacity:()=>3,available:()=>20000,
    claim(w,s){state.waiters.splice(state.waiters.indexOf(w),1);claimed.push(s);}});
  for(let n=0;n<3;n++)state.waiters.push({jobId:'r'+n,resourceKey:'frameshift',homeKind:'motion-home',priority:0,seq:n});
  q.drain();assert.equal(claimed.length,3);
  for(const s of claimed)s.phase='native-wait';
  // two more renders fit the recovery room (cap 3 + room 2); they fall back too -> the room is full
  for(let n=3;n<5;n++)state.waiters.push({jobId:'r'+n,resourceKey:'frameshift',homeKind:'motion-home',priority:0,seq:n});
  q.drain();assert.equal(claimed.length,5);
  for(const s of claimed)s.phase='native-wait';
  for(let n=0;n<6;n++)state.waiters.push({jobId:'v'+n,resourceKey:'frameshift',homeKind:'motion-validation',priority:0,seq:10+n});
  state.waiters.push({jobId:'late',resourceKey:'frameshift',homeKind:'motion-home',priority:0,seq:20});
  q.drain();
  const st=q.stats();
  assert.equal(st.validationActive,4,'validations fill their own 4 slots despite 5 recovering');
  assert.ok(!claimed.some(s=>s.jobId==='late'),'renders wait while the recovery room is full');
  delete globalThis.__vfHomeMotionValidation;
});
test('renders and validations each fill their own room: 9 renders do not keep the validation worker idle',()=>{
  const state={waiters:[]},claimed=[];
  globalThis.__vfHomeMotionValidation={ready:()=>true,capacity:()=>4};
  const q=api.createQueue({getState:()=>state,getCapacity:()=>9,available:()=>20000,
    claim(w,s){state.waiters.splice(state.waiters.indexOf(w),1);claimed.push(s);}});
  for(let n=0;n<12;n++)state.waiters.push({jobId:'r'+n,resourceKey:'frameshift',homeKind:'motion-home',priority:'4|03',seq:n});
  for(let n=0;n<6;n++)state.waiters.push({jobId:'v'+n,resourceKey:'frameshift',homeKind:'motion-validation',priority:'4|05',seq:100+n});
  q.drain();
  const st=q.stats();
  assert.equal(st.validationActive,4);assert.equal(st.homeActive,13,'9 renders + 4 validations');
  assert.equal(claimed.filter(s=>!s.validation).length,9);
  delete globalThis.__vfHomeMotionValidation;
});
