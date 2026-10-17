import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import * as home from '../node/home-siglip.mjs';

const embed='()=>(a.embedAndRank||ZQ)({query:Je,extraQueries:[...tr.slice(1),...mt,g].filter(Boolean),negativeQueries:ce?dQe:[],shots:pr,deadlineTs:Date.now()+12e4})';
const preselect='()=>(a.embedAndRank||ZQ)({query:Ie[0]||g,extraQueries:[...Ie.slice(1),g].filter(Boolean),negativeQueries:dQe,shots:jn.map(vs=>({shot_id:vs.index,start_sec:0,end_sec:0,duration_sec:0,thumbnail_url:vs.thumbnailUrl})),deadlineTs:Date.now()+3e4})';

test('closed embedding families exclude OCR and altered callbacks',()=>{
  assert.equal(home.isHomeSiglipEmbedCallback(embed),true);
  assert.equal(home.isHomeSiglipEmbedCallback(preselect),true);
  for(const fn of ['()=>ocr()',embed+';compute()',embed.replace('ZQ','unknown')])
    assert.equal(home.isHomeSiglipEmbedCallback(fn),false);
});

test('Home claims independently of native model RAM blockage and preserves priority/FIFO',()=>{
  let nonce=0;
  const state={activeTotal:14,activeByResource:new Map([['siglip',14]]),waiters:[
    {jobId:'late',resourceKey:'siglip',homeKind:'siglip-home',priority:'b',seq:0},
    {jobId:'first',resourceKey:'siglip',homeKind:'siglip-home',priority:'a',seq:1},
    {jobId:'ocr',resourceKey:'siglip',homeKind:'siglip-server',priority:'a',seq:2}],memoryBlocked:true};
  const order=[];
  const q=home.createHomeSiglipQueue({getState:()=>state,getCapacity:()=>2,newNonce:()=>String(++nonce),
    claim:(w,s)=>{order.push(w.jobId);state.waiters.splice(state.waiters.indexOf(w),1);state.activeTotal++;state.activeByResource.set('siglip',state.activeByResource.get('siglip')+1);}});
  q.drain();assert.deepEqual(order,['first','late']);assert.equal(q.stats().active,2);
  q.serverView(()=>{assert.equal(state.activeTotal,14);assert.equal(state.activeByResource.get('siglip'),14);});
  assert.equal(state.activeTotal,16);assert.equal(state.memoryBlocked,true);
});

test('offline/cancellation stops new claims and unknown candidates are limited to two',()=>{
  let capacity=14;
  const state={activeTotal:0,activeByResource:new Map(),waiters:Array.from({length:20},(_,seq)=>({jobId:'j'+seq,resourceKey:'siglip',homeKind:'siglip-home-candidate',priority:'a',seq}))};
  const q=home.createHomeSiglipQueue({getState:()=>state,getCapacity:()=>capacity,claim:w=>state.waiters.splice(state.waiters.indexOf(w),1)});
  q.drain();assert.equal(q.stats().active,2);
  capacity=0;q.drain();assert.equal(q.stats().active,2);
});

test('aggregate transport budget is bounded and releases exactly once',()=>{
  const b=home.createHomeSiglipBufferBudget(64),a=b.open(8),c=b.open(8);
  a.addBytes(5);assert.equal(b.stats().reservedBytes,56);
  assert.throws(()=>c.addBytes(2),/buffer budget/);
  a.close();a.close();c.close();assert.equal(b.stats().reservedBytes,0);
});

test('unknown callbacks and PC-off fallbacks hold normal admission through full callback',async()=>{
  const storage=new AsyncLocalStorage(),scopes=new Map();
  let active=0,maxActive=0;
  const state={activeTotal:0,activeByResource:new Map(),waiters:[]};
  const q=home.createHomeSiglipQueue({getState:()=>state,getCapacity:()=>14,claim(){},scopes});
  const pending=[];
  const runNative=async(job,fn,signal)=>{active++;maxActive=Math.max(maxActive,active);try{return await fn();}finally{active--;}};
  home.attachHomeSiglipRecovery(q,{runNative,runNativeContext:(s,fn)=>storage.run({native:true},fn),isAborted:()=>false});
  for(let i=0;i<3;i++){
    const scope={nonce:String(i),jobId:'job'+i,kind:'siglip-embed',candidate:true};scopes.set(scope.nonce,scope);
    let resolve;const done=new Promise(r=>resolve=r);
    const callback=async()=>{assert.ok(storage.getStore().native);await done;return i;};
    pending.push({task:q.runCallback(scope,callback),resolve});
  }
  await new Promise(r=>setTimeout(r,20));assert.equal(active,2);
  pending[0].resolve();assert.equal(await pending[0].task,0);
  pending[1].resolve();pending[2].resolve();await Promise.all(pending.map(p=>p.task));
  assert.equal(maxActive,2);assert.equal(active,0);
});

test('already aborted callback signal is combined into the Home lease before transport',async()=>{
  const scope={jobId:'j',nonce:'n',kind:'siglip-embed'},controller=new AbortController();
  const reason=Object.assign(Error('winner selected'),{code:'video_pipeline_cancelled'});controller.abort(reason);
  let embedding=payload=>{assert.equal(globalThis.__vfHomeSiglipScope().signal.aborted,true);throw payload.signal.reason;};
  let admission=()=>null,release=()=>{},sampler=()=>null;
  const state={activeTotal:0,activeByResource:new Map(),waiters:[]};
  const context={leases:new Map([['siglip',{boosted:scope}]])};
  const scheduler={run(){},stats:()=>({}),isJobAborted:()=>false};
  const queue=home.installHomeSiglipAdmission({scheduler,getState:()=>state,getContext:()=>context,claim(){},
    getAdmission:()=>admission,setAdmission:v=>{admission=v},getRelease:()=>release,setRelease:v=>{release=v},
    getSlotMeasurer:()=>sampler,setSlotMeasurer:v=>{sampler=v},runIndependent:fn=>fn(),runNativeContext:()=>{throw Error('must not recover cancellation');},
    getCapacity:()=>14,getEmbedder:()=>embedding,setEmbedder:v=>{embedding=v},schedule:()=>({unref(){}})});
  state.waiters.push({resourceKey:'siglip',homeKind:'siglip-home',jobId:'j',priority:'a',seq:1});
  // Register through the actual claim path, then use its original nonce-bearing lease.
  let captured;
  state.waiters[0].resolve=lease=>{captured=lease.homeScope;};
  const originalClaim=state.waiters[0];
  // The installation's fake claim can be replaced by an explicit queue for recovery testing.
  const q=home.createHomeSiglipQueue({getState:()=>state,getCapacity:()=>1,claim:(w,s)=>{captured=s;state.waiters.splice(state.waiters.indexOf(w),1);}});
  q.drain();context.leases.set('siglip',{boosted:captured});
  globalThis.__vfHomeSiglipScope=()=>q.getScope(captured);
  assert.throws(()=>embedding({signal:controller.signal}),error=>error===reason);
  assert.equal(captured.signal.aborted,true);
  delete globalThis.__vfHomeSiglipQueue;delete globalThis.__vfHomeSiglipScope;delete globalThis.__vfHomeSiglipAttachSignal;
  delete globalThis.__vfHomeSiglipRecovery;delete globalThis.__vfHomeSiglipBuffers;
});
