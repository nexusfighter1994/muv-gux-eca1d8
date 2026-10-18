import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';

const media=await import('../node/home-media.mjs').catch(()=>({}));

test('hot upgrade preserves scheduler and counters, installs executor only once',async()=>{
  const storage=new AsyncLocalStorage(),scope={kind:'video-trim',nonce:'n'};
  let calls=0,recoveries=0,installs=0,exec=async()=>{calls++;return {stdout:'native'};};
  const scheduler={run(){}};const run=scheduler.run;
  const stats={attempted:0,gpu:0,fallback:8,tagged:8};
  globalThis.__vfHomeMedia={stats,activatedAt:'existing'};
  const options={scheduler,getExec:()=>exec,setExec:value=>{installs++;exec=value;},
    getContext:()=>storage.getStore(),getBinary:()=>'/ffmpeg',
    classifyCallback:()=>null,classifyArgv:()=>true,
    runCli:async()=>({offloaded:true,metadata:{verified:true,lane:'gpu',gpuPolicy:'nvenc-high-qp14-v1'}}),
    runRecovery:(s,fn)=>{recoveries++;return fn();},runNativeContext:(s,fn)=>storage.run({},fn)};
  try{
    const state=media.installHomeMedia(options);
    assert.equal(state.version,2);assert.equal(state.stats,stats);assert.equal(scheduler.run,run);
    assert.equal(media.installHomeMedia(options),state);assert.equal(installs,1);
    const result=await storage.run({leases:new Map([['ffmpeg',{boosted:scope}]])},()=>exec('/ffmpeg',['-y','-hide_banner','-loglevel','error','exact']));
    assert.match(result.stdout,/GPU/);assert.equal(stats.gpu,1);assert.equal(stats.fallback,8);
    assert.equal(calls,0);assert.equal(recoveries,0);
  }finally{delete globalThis.__vfHomeMedia;}
});

test('media executor bridge exists',()=>{
  assert.equal(typeof media.wrapHomeMediaExec,'function');
});

test('v2 busy recovery delegates through v1 without a second permit or offload',async()=>{
  const storage=new AsyncLocalStorage(),scope={kind:'video-trim',nonce:'n'};
  let native=0,oldRemote=0,newRemote=0,permits=0;
  const args=['-y','-hide_banner','-loglevel','error','exact'];
  const options={timeoutMs:120000};
  const common={getContext:()=>storage.getStore(),getBinary:()=>'/ffmpeg',
    runRecovery:(s,fn)=>{permits++;return fn();},
    runNativeContext:(s,fn)=>storage.run({leases:new Map([['ffmpeg',{boosted:false}]])},fn)};
  let exec=media.wrapHomeMediaExec(async(b,a,o)=>{
    native++;assert.equal(a,args);assert.equal(o,options);return 'native';
  },{...common,qualify:()=>true,runCli:async()=>{oldRemote++;return null;}});
  globalThis.__vfHomeMedia={stats:{attempted:0,gpu:0,fallback:0,tagged:0}};
  try{
    media.installHomeMedia({...common,scheduler:{run(){}},getExec:()=>exec,setExec:v=>{exec=v;},
      classifyCallback:()=>null,classifyArgv:()=>true,runCli:async()=>{newRemote++;return null;}});
    const result=await storage.run({leases:new Map([['ffmpeg',{boosted:scope}]])},()=>exec('/ffmpeg',args,options));
    assert.equal(result,'native');assert.deepEqual([native,oldRemote,newRemote,permits],[1,0,1,1]);
  }finally{delete globalThis.__vfHomeMedia;}
});

test('Home GPU success avoids native execution; unknown context stays native',async()=>{
  if(!media.wrapHomeMediaExec)return assert.fail('media bridge missing');
  let native=0,remote=0,recover=0;
  const scope={kind:'video-trim',nonce:'n'};
  let context={leases:new Map([['ffmpeg',{boosted:scope}]])};
  const wrapped=media.wrapHomeMediaExec(async()=>{native++;return {stdout:'native'};},{
    getContext:()=>context,getBinary:()=>'/ffmpeg',qualify:()=>({argv:['exact']}),
    runCli:async()=>{remote++;return {offloaded:true,metadata:{verified:true,lane:'gpu',gpuPolicy:'nvenc-high-qp14-v1'}};},
    runRecovery:async(s,fn)=>{recover++;return fn();},runNativeContext:(s,fn)=>fn()});
  assert.match((await wrapped('/ffmpeg',['original'])).stdout,/Home PC GPU/);
  assert.deepEqual([native,remote,recover],[0,1,0]);
  context=null;assert.equal((await wrapped('/ffmpeg',['original'])).stdout,'native');
  assert.deepEqual([native,remote,recover],[1,1,0]);
});

test('busy/offline/invalid responses recover once with original args/options and masked scope',async()=>{
  if(!media.wrapHomeMediaExec)return assert.fail('media bridge missing');
  for(const response of [null,{offloaded:false},new Error('offline'),{offloaded:true,metadata:{verified:true,lane:'cpu'}}]){
    const storage=new AsyncLocalStorage(),scope={kind:'video-trim',nonce:'n'};
    let permits=0,native=0;
    const args=['original'],options={timeoutMs:120000,signal:new AbortController().signal};
    const wrapped=media.wrapHomeMediaExec(async(binary,a,o)=>{
      native++;assert.equal(storage.getStore().leases.get('ffmpeg').boosted,false);
      assert.equal(a,args);assert.equal(o,options);assert.equal(permits,1);return 42;
    },{getContext:()=>storage.getStore(),getBinary:()=>'/ffmpeg',qualify:()=>({argv:['exact']}),
      runCli:async()=>{if(response instanceof Error)throw response;return response;},
      runRecovery:async(s,fn)=>{assert.equal(s,scope);permits++;return fn();},
      runNativeContext:(s,fn)=>storage.run({leases:new Map([['ffmpeg',{boosted:false}]])},fn)});
    assert.equal(await storage.run({leases:new Map([['ffmpeg',{boosted:scope}]])},()=>wrapped('/ffmpeg',args,options)),42);
    assert.deepEqual([native,permits],[1,1]);
  }
});

test('unrecognized recipe inside a Home scope is never an uncounted server encode',async()=>{
  if(!media.wrapHomeMediaExec)return assert.fail('media bridge missing');
  let permits=0,remote=0;
  const wrapped=media.wrapHomeMediaExec(async()=>{assert.equal(permits,1);return 7;},{
    getContext:()=>({leases:new Map([['ffmpeg',{boosted:{kind:'video-trim'}}]])}),
    getBinary:()=>'/ffmpeg',qualify:()=>null,runCli:async()=>{remote++;},
    runRecovery:async(s,fn)=>{permits++;return fn();},runNativeContext:(s,fn)=>fn()});
  assert.equal(await wrapped('/ffmpeg',['unrecognized']),7);assert.equal(remote,0);
});

test('cancellation never starts a native fallback; bridge requires context masking',async()=>{
  if(!media.wrapHomeMediaExec)return assert.fail('media bridge missing');
  assert.throws(()=>media.wrapHomeMediaExec(()=>{},{}),/runNativeContext/);
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  const wrapped=media.wrapHomeMediaExec(()=>assert.fail('native after cancellation'),{
    getContext:()=>({leases:new Map([['ffmpeg',{boosted:{kind:'video-trim'}}]])}),getBinary:()=>'/ffmpeg',
    qualify:()=>({}),runCli:()=>assert.fail('remote after cancellation'),
    runRecovery:()=>assert.fail('permit after cancellation'),runNativeContext:(s,fn)=>fn()});
  await assert.rejects(wrapped('/ffmpeg',[],{signal:controller.signal}),/cancelled/);
});
