import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapHomeScenes,installHomeScenes} from '../node/home-scenes.mjs';
function setup(result){const calls=[],scope={kind:'video-trim',jobId:'x',candidate:true},stats={attempted:0,gpu:0,cpu:0,fallback:0};
  const fn=wrapHomeScenes(async()=>{calls.push('native');return 'native'}, {
    getContext:()=>({leases:new Map([['ffmpeg',{boosted:scope}]])}),validScope:()=>true,enabled:()=>true,stats,
    runCli:async()=>{calls.push('home');return result},getPublisher:async()=>()=>'/preview',record:()=>{},
    runRecovery:async(s,fn)=>{calls.push('permit');return fn()},runNativeContext:(s,fn)=>fn()});return {fn,calls,stats};}
test('CPU/GPU results retain exact cuts and generate previews',async()=>{
 for(const backend of ['CPU scenes','NVDEC + CPU scenes']){const s=setup({offloaded:true,verified:true,backend,videoFps:30,projectSlug:'real-project-123',
  shots:[{shot_id:1,start_sec:0,end_sec:3,thumbnailPath:'/data/projects/real-project-123/home-scene-previews/x/a/shot_1.jpg'}]});
  const r=await s.fn({deadlineTs:Date.now()+240000});assert.equal(r.videoFps,30);assert.equal(r.shots[0].end_sec,3);
  assert.deepEqual(s.calls,['home']);assert.equal(s.stats.cpu+s.stats.gpu,1);}
});
test('unavailable Home uses counted original server fallback',async()=>{const s=setup({offloaded:false});
 assert.equal(await s.fn({deadlineTs:Date.now()+240000}),'native');assert.deepEqual(s.calls,['home','permit','native']);});
test('short deadlines preserve native budget',async()=>{const s=setup({});await s.fn({deadlineTs:Date.now()+60000});
 assert.deepEqual(s.calls,['permit','native']);});
test('out of scope previews are rejected',async()=>{const s=setup({offloaded:true,verified:true,backend:'CPU scenes',shots:[{thumbnailPath:'/etc/passwd'}]});
 await s.fn({deadlineTs:Date.now()+240000});assert.deepEqual(s.calls,['home','permit','native']);});
test('cancelled work never renders or falls back',async()=>{const s=setup({});const c=new AbortController();c.abort(Error('Stopped'));
 await assert.rejects(s.fn({signal:c.signal}),/Stopped/);assert.deepEqual(s.calls,[]);});
test('cold install publishes scene counters and remains idempotent',()=>{
 let render=()=>{},measurer=()=>{};const scheduler={run(){}};
 globalThis.__vfHomeQueue={stats:()=>({active:2})};delete globalThis.__vfHomeScenes;
 try{
  const d={scheduler,getState:()=>({waiters:[]}),getRender:()=>render,setRender:fn=>render=fn,
   getSlotMeasurer:()=>measurer,setSlotMeasurer:fn=>measurer=fn,hash:()=>'',enabled:()=>true};
  const hook=installHomeScenes(d),saved=render;assert.equal(hook.version,2);
  assert.equal(globalThis.__vfHomeQueue.stats().scenes.gpu,0);assert.equal(globalThis.__vfHomeQueue.stats().active,2);
  assert.equal(installHomeScenes(d),hook);assert.equal(saved,render);
 }finally{delete globalThis.__vfHomeScenes;delete globalThis.__vfHomeQueue;}
});

test('new native inline-thumbnail option keeps the owned JPEG and rejects oversized previews',async()=>{
 const original=process.getBuiltinModule;
 try{
  let size=4;
  process.getBuiltinModule=name=>name==='fs'?{statSync:()=>({size}),readFileSync:()=>Buffer.from([255,216,255,217])}:original(name);
  const result={offloaded:true,verified:true,backend:'NVDEC + CPU scenes',videoFps:30,projectSlug:'real-project-123',
    shots:[{shot_id:1,start_sec:0,end_sec:3,thumbnailPath:'/data/projects/real-project-123/home-scene-previews/x/a/shot_1.jpg'}]};
  const s=setup(result),rendered=await s.fn({deadlineTs:Date.now()+240000,includeThumbnailData:true});
  assert.equal(rendered.shots[0].thumbnail_data_url,'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(rendered.shots[0].thumbnail_url,'/preview');
  size=2*1024*1024+1;const fallback=setup(result);
  assert.equal(await fallback.fn({deadlineTs:Date.now()+240000,includeThumbnailData:true}),'native');
  assert.deepEqual(fallback.calls,['home','permit','native']);
 }finally{process.getBuiltinModule=original;}
});
