'use strict';
const {test,afterEach,mock}=require('node:test');
const assert=require('node:assert/strict'),vm=require('node:vm');
const fixture=require('./fixtures/native-chunk-20261023.json');
const {createRecovery}=require('../node/home-chunk-recovery.cjs');
const MIN=60000,scope={jobId:'parent',nonce:'lease',kind:'composition'};
afterEach(()=>mock.restoreAll());

function setup({home=true,valid=true,chunk=true,engine='fflow',timeoutMs=30*MIN,fetch,onTick}={}){
 let clock=0,calls=0;const cancels=[],ticks=[];
 mock.method(Date,'now',()=>clock);
 const ctx=vm.createContext({Date,setTimeout:(fn,ms)=>{clock+=ms;queueMicrotask(fn);},
  h5e:()=>({}),ses:s=>({code:'RENDER_FAILED',message:s.data.error?.message||'failed'}),BAe:Error});
 vm.runInContext(fixture.ec,ctx);
 const r=createRecovery({getContext:()=>({leases:new Map([['ffmpeg',{boosted:home?scope:null}]])}),
  validScope:()=>valid,isAborted:()=>false,cancel:async id=>cancels.push(id)});
 const options={engine,remoteJobId:'exact-remote',timeoutMs,intervalMs:MIN,
  fetchStatus:async()=>{calls++;return fetch(clock/MIN,calls);},
  isDone:s=>s.data.status==='completed',isFailed:s=>['failed','cancelled'].includes(s.data.status),
  onTick:s=>{ticks.push(s);onTick?.(s);}};
 let poll=r.wrapPoll(ctx.ec),wrapChunk=fn=>r.wrapChunk(fn);
 if(process.env.VF_TEST_HOT_BRIDGE==='1'){
  const bridge=require('../node/home-chunk-budget.cjs').createHotBridge({
   getContext:()=>({leases:new Map([['ffmpeg',{boosted:home?scope:null}]])}),validScope:()=>valid,
   isNativeRecovery:r.nativeRecovery});
  poll=bridge.wrapPoll(poll);wrapChunk=fn=>bridge.wrapChunk(r.wrapChunk(fn));
 }
 const invoke=()=>poll(options);
 return {run:()=>chunk?wrapChunk(invoke)({jobId:scope.jobId}):invoke(),cancels,ticks,options,
  clock:()=>clock,calls:()=>calls,r};
}
const state=(progress,step='preparing_segments',status='processing',extra={})=>
 ({data:{status,progress,current_step:step,...extra}});

test('real chunk24-like progress survives30min and completes at35min',async()=>{
 const f=setup({fetch:t=>t>=35?state(100,'cleaning_up','completed'):
  t>=23?state(70,'mixing_audio'):t>=19?state(60,'concatenating'):
  state(Math.floor(t/5)*10+20)});
 const result=await f.run();
 assert.equal(result.data.status,'completed');assert.equal(f.clock(),35*MIN);
 assert.deepEqual(f.cancels,[]);assert.equal(f.options.timeoutMs,30*MIN);
});

test('unchanged render and changing heartbeat still stop at30min',async()=>{
 const f=setup({fetch:t=>state(70,'mixing_audio','processing',{updated_at:String(t),heartbeat:t})});
 await assert.rejects(f.run(),e=>e.timedOut&&/without render progress/.test(e.message));
 assert.equal(f.clock(),30*MIN);assert.deepEqual(f.cancels,['exact-remote']);
});

test('one real advance at20min grants only30min more idle time',async()=>{
 const f=setup({fetch:t=>state(t>=20?70:60,t>=20?'mixing_audio':'concatenating')});
 await assert.rejects(f.run(),e=>e.timedOut&&/without render progress/.test(e.message));
 assert.equal(f.clock(),50*MIN);assert.deepEqual(f.cancels,['exact-remote']);
});

test('continuous progress cannot exceed60min absolute cap',async()=>{
 const f=setup({fetch:t=>state(t)});
 await assert.rejects(f.run(),e=>e.timedOut&&/3600000ms/.test(e.message));
 assert.equal(f.clock(),60*MIN);assert.deepEqual(f.cancels,['exact-remote']);
});

test('cyclic stage/progress regressions are not fresh progress',async()=>{
 const f=setup({fetch:t=>t===0?state(50,'preparing_segments'):
  state(t%2?60:50,t%2?'concatenating':'preparing_segments')});
 await assert.rejects(f.run(),e=>e.timedOut&&/without render progress/.test(e.message));
 assert.equal(f.clock(),31*MIN);assert.deepEqual(f.cancels,['exact-remote']);
});

for(const args of [{home:false},{valid:false},{chunk:false},{engine:'other'},{timeoutMs:20*MIN}])
 test('unrelated/native/shorter poll retains original budget '+JSON.stringify(args),async()=>{
  const f=setup({...args,fetch:t=>state(t)});
  await assert.rejects(f.run(),e=>e.timedOut);
  assert.equal(f.clock(),args.timeoutMs||30*MIN);
 });

test('native terminal failure stays immediate and is not canceled or retried',async()=>{
 const f=setup({fetch:t=>t>=31?state(0,'cleaning_up','failed',{error:{message:'invalid codec'}}):state(t)});
 await assert.rejects(f.run(),/invalid codec/);assert.equal(f.clock(),31*MIN);
 assert.deepEqual(f.cancels,[]);
});

test('completed status wins over idle watchdog and invokes original onTick',async()=>{
 let ticks=0;
 const f=setup({fetch:t=>t>=30?state(100,'cleaning_up','completed'):state(70,'mixing_audio'),onTick:()=>ticks++});
 assert.equal((await f.run()).data.status,'completed');assert.equal(ticks,31);
 assert.deepEqual(f.cancels,[]);
});

test('native fetch error retry count remains bounded',async()=>{
 const f=setup({fetch:()=>{throw Error('network down');}});
 await assert.rejects(f.run(),/network down/);assert.equal(f.calls(),5);
 assert.deepEqual(f.cancels,['exact-remote']);
});
