'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AsyncLocalStorage}=require('node:async_hooks');
const load=()=>require('../node/home-motion-recovery-order.cjs');
test('fallback inherits its owned parent FIFO position across async recovery waits',async()=>{
  const als=new AsyncLocalStorage(),a={seq:7},b={seq:9},owned=new Set([a,b]);
  const higher={jobId:'higher',priority:'a',seq:30},later={jobId:'job',priority:'z',seq:20};
  const state={waiters:[higher,later]};let calls=0;
  const scheduler={run(jobId,resource,fn,options){calls++;state.waiters.push({jobId,resourceKey:resource,homeKind:options.homeKind,priority:'z',seq:40+calls});return Promise.resolve('queued');}};
  const queue={valid:s=>owned.has(s),async native(fn){await new Promise(r=>setImmediate(r));return scheduler.run('job','frameshift',fn,{homeKind:'motion-native-recovery'});}};
  const deps={queue,scheduler,getState:()=>state,getContext:()=>als.getStore()};
  load().install(deps);const native=queue.native,run=scheduler.run;load().install(deps);
  assert.equal(native,queue.native);assert.equal(run,scheduler.run);
  assert.deepEqual(await Promise.all([a,b].map(s=>als.run({leases:new Map([['render',{boosted:s}]])},()=>queue.native(()=>assert.fail('not admitted'))))),['queued','queued']);
  assert.deepEqual(state.waiters.map(w=>w.seq),[30,20,7,9]);assert.equal(calls,2);
  assert.deepEqual([...state.waiters].sort((x,y)=>x.priority<y.priority?-1:x.priority>y.priority?1:x.seq-y.seq).map(w=>w.seq),[30,7,9,20]);
});
test('unowned, old unsequenced and ordinary requests keep native ordering and function flags',async()=>{
  const als=new AsyncLocalStorage(),state={waiters:[]},scope={};let calls=0;
  const scheduler={run(jobId,resource,fn,options){const w={jobId,homeKind:options.homeKind,seq:++calls};state.waiters.push(w);return w;}};
  scheduler.run.__vfHomeMotion=true;
  const queue={valid:s=>s===scope,native:fn=>fn()};
  load().install({queue,scheduler,getState:()=>state,getContext:()=>als.getStore()});
  assert.equal(scheduler.run.__vfHomeMotion,true);
  for(const s of [scope,{seq:0}])await als.run({leases:new Map([['render',{boosted:s}]])},()=>queue.native(()=>scheduler.run('job','frameshift',()=>{}, {homeKind:'motion-native-recovery'})));
  scope.seq=0;await als.run({leases:new Map([['render',{boosted:scope}]])},()=>queue.native(()=>scheduler.run('job','frameshift',()=>{}, {homeKind:'motion-native'})));
  assert.deepEqual(state.waiters.map(w=>w.seq),[1,2,3]);
});
test('immediate admission and errors remain native; no callback replay',()=>{
  const scope={seq:1},queue={valid:s=>s===scope,native:fn=>fn()},state={waiters:[]};let calls=0;
  const scheduler={run(id,resource,fn){calls++;return fn();}};
  load().install({queue,scheduler,getState:()=>state,getContext:()=>({leases:new Map([['render',{boosted:scope}]])})});
  assert.equal(queue.native(()=>scheduler.run('job','frameshift',()=>42,{homeKind:'motion-native-recovery'})),42);
  assert.throws(()=>queue.native(()=>scheduler.run('job','frameshift',()=>{throw Error('original');},{homeKind:'motion-native-recovery'})),/original/);
  assert.equal(calls,2);assert.deepEqual(state.waiters,[]);
});
