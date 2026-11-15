import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createServerPermits} from '../node/home-queue.mjs';
import {installHomeDirect} from '../node/home-direct.mjs';
import {installHomeLibraryTrim} from '../node/home-library-trim.mjs';
import {installHomeCamera} from '../node/home-camera.mjs';
import {createHash} from 'node:crypto';

test('startup retry after another scheduler wrapper cannot nest native recovery scopes',async()=>{
  const storage=new AsyncLocalStorage(),scope={kind:'video-normalize',nonce:'owned',jobId:'job'},signal=new AbortController().signal;
  const context={jobId:'job',lanes:new Set(['ffmpeg']),leases:new Map([['ffmpeg',{boosted:scope,signal}]])};
  let sampler=()=>({run:fn=>fn(),finish(){finished++;}}),created=0,native=0,finished=0;
  const permits=createServerPermits({validScope:s=>s===scope,run:async(_,fn)=>fn(),maxRunning:2});
  const scheduler={run:(_,__,fn)=>fn()};
  const deps={scheduler,getSlotMeasurer:()=>sampler,setSlotMeasurer:v=>sampler=v,getContext:()=>storage.getStore(),
    runRecovery:async(s,fn)=>{
      created++;const id=permits.create(s),until=Date.now()+2000;
      try{while(permits.get(id)?.state!=='active'){assert.ok(Date.now()<until,'permit bounded');await new Promise(r=>setImmediate(r));}return await fn();}
      finally{permits.close(id);}
    },
    runNativeContext:(s,fn)=>{
      const c=storage.getStore(),old=c?.leases?.get('ffmpeg');
      if(!c||old?.boosted?.nonce!==s.nonce)throw Error('Native recovery scope mismatch');
      const leases=new Map(c.leases);leases.set('ffmpeg',{...old,boosted:false});return storage.run({...c,leases},fn);
    }};
  installHomeDirect(deps);installHomeLibraryTrim(deps);
  const before=sampler,previous=scheduler.run;
  scheduler.run=function(...args){return previous.apply(this,args);};
  installHomeDirect(deps);installHomeLibraryTrim(deps);
  const result=await storage.run(context,async()=>{
    const sample=sampler({lane:'ffmpeg',resourceKey:'ffmpegHome'});
    try{return await sample.run(()=>{native++;assert.equal(storage.getStore().leases.get('ffmpeg').boosted,false);return 42;});}
    finally{sample.finish();}
  });
  assert.equal(result,42);assert.equal(created,1);assert.equal(native,1);assert.equal(finished,1);
  assert.equal(sampler,before,'existing sampler chain must remain intact');
  assert.equal(context.leases.get('ffmpeg').boosted,scope);
});

test('repeated installs preserve an unrelated outer sampler and scheduler options',()=>{
  let sampler=()=>null;
  const scheduler={run(...args){return args;}};
  const deps={scheduler,getSlotMeasurer:()=>sampler,setSlotMeasurer:v=>sampler=v,
    getContext:()=>null,runRecovery:()=>assert.fail('unexpected'),runNativeContext:()=>assert.fail('unexpected')};
  installHomeDirect(deps);installHomeLibraryTrim(deps);
  const inner=sampler,outer=function(request){return inner(request);};sampler=outer;
  const run=scheduler.run;scheduler.run=function(...args){return run.apply(this,args);};
  for(let i=0;i<8;i++){installHomeDirect(deps);installHomeLibraryTrim(deps);}
  assert.equal(sampler,outer);
  const callback=()=>7,options={signal:new AbortController().signal,operation:'original'};
  assert.deepEqual(scheduler.run('job','other',callback,options),['job','other',callback,options]);
});

test('the exact production camera callback remains eligible for Home after startup retries',async()=>{
  delete globalThis.__vfHomeCamera;
  const storage=new AsyncLocalStorage(),scope={kind:'video-normalize',candidate:true,nonce:'camera-owned',jobId:'job'};
  let sampler=()=>({run:fn=>fn(),finish(){}}),home=0,native=0,permits=0;
  let render=()=>{native++;return 'native';};
  const scheduler={run:(_,__,fn)=>fn()};
  const d={scheduler,getSlotMeasurer:()=>sampler,setSlotMeasurer:v=>sampler=v,getContext:()=>storage.getStore(),
    getState:()=>({waiters:[]}),getRender:()=>render,setRender:v=>render=v,
    hash:s=>createHash('sha256').update(s).digest('hex'),enabled:()=>true,validScope:s=>s===scope,
    makeRequest:()=>({source:'source.jpg',target_resolution:'1920x1080',fps:24,duration_frames:72,camera_path:{track:{zoom:[1,1.2]}},wait_for_results:false}),
    runCli:async()=>{home++;return {offloaded:true,verified:true};},
    runRecovery:()=>{permits++;throw Error('unexpected native fallback');},runNativeContext:()=>assert.fail('unexpected native context')};
  installHomeDirect(d);installHomeLibraryTrim(d);installHomeCamera(d);
  installHomeDirect(d);installHomeLibraryTrim(d);
  const callback=()=>render({targetPath:'/unchanged.mp4'});
  callback.toString=()=> 'async()=>{if(Fs()){await aQn({imagePath:t,durationSeconds:r,targetPath:f,motion:p});return}await _Ke({fflowClient:c,pollJobFn:l,imagePath:t,durationSeconds:r,targetPath:f,checkpoint:i,motion:p})}';
  try{
    const result=await storage.run({jobId:'job',lanes:new Set(['ffmpeg']),leases:new Map([['ffmpeg',{boosted:scope}]])},
      ()=>sampler({lane:'ffmpeg',resourceKey:'ffmpegHome'}).run(callback));
    assert.equal(result.targetPath,'/unchanged.mp4');assert.equal(home,1);assert.equal(native,0);assert.equal(permits,0);
  }finally{delete globalThis.__vfHomeCamera;}
});
