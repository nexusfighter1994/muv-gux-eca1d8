'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const extras=require('../node/pc-status-extras.cjs');
let events={};try{events=require('../node/home-motion-events.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('status exposes Motion queue and actual staging allocation without changing RAM entries',()=>{
  const before={q:globalThis.__vfHomeMotionQueue,r:globalThis.__vfRamAllocations};
  const entry={laneKey:'render',resourceKey:'motionHome',estimateMb:1024};
  try{
    globalThis.__vfHomeMotionQueue={stats:()=>({active:2,homeActive:1,recovering:1,queued:31})};
    globalThis.__vfRamAllocations=new Map([[1,entry],[2,{...entry,resourceKey:'frameshift',estimateMb:4096}]]);
    const result=extras.statusExtras();assert.equal(result.homeMotionQueue.active,2);
    assert.equal(result.homeMotionQueue.serverStagingMb,1024);assert.equal(result.homeMotionQueue.serverStagingAllocations,1);
    assert.equal(entry.estimateMb,1024);
  }finally{globalThis.__vfHomeMotionQueue=before.q;globalThis.__vfRamAllocations=before.r;}
});
test('confirmed Home artifact log is bounded, deduplicated, and never guesses native or Pod provenance',()=>{
  assert.equal(typeof events.createRecorder,'function');const out=[];const r=events.createRecorder({emit:e=>out.push(e)});
  const artifact={backend:'home',jobId:'job',kind:'opaque',path:'/data/projects/test/chunks/chunk_24/segments/segment_1.part.mp4'};
  r.record({...artifact,backend:'native'});r.record({...artifact,backend:'pod'});
  r.record({...artifact,path:'/data/projects/../private/secret.mp4'});assert.equal(out.length,0);
  r.record(artifact);r.record(artifact);assert.equal(out.length,1);
  assert.match(out[0].message,/\(Home PC\).*CPU.*Chunk 24 segment 1/);assert.equal(out[0].jobId,'job');
  assert.equal(out[0].data.homeMotionArtifact,true);assert.doesNotMatch(out[0].message,/NVENC|GPU/);
  for(let n=0;n<2100;n++)r.record({...artifact,path:`/data/projects/test/chunks/chunk_24/segments/segment_${n+2}.mp4`});
  assert.ok(r.stats().retained<=2000);
});
test('observability failure never fails rendering',()=>{
  assert.equal(typeof events.createRecorder,'function');const r=events.createRecorder({emit(){throw Error('database busy');}});
  assert.doesNotThrow(()=>r.record({backend:'home',jobId:'job',kind:'alpha',path:'/data/projects/test/overlay.mov'}));
});
test('legacy live receipt observer distinguishes Home and Pod atomic success counters without replacing render functions',()=>{
  assert.equal(typeof events.attachLegacyRoute,'function');const emitted=[];
  const route={wrap:()=>{},stats:{opaque:{home:12},alpha:{home:20},low:{home:3},pod:{home:2},last:null}};
  const wrap=route.wrap,recorder=events.createRecorder({emit:e=>emitted.push(e)});
  events.attachLegacyRoute(route,recorder);events.attachLegacyRoute(route,recorder);
  const value=n=>({jobId:'job',kind:'opaque',path:`/data/projects/p/chunks/chunk_1/segments/segment_${n}.mp4`});
  route.stats.opaque.home++;route.stats.last=value(1);assert.equal(emitted.length,1);
  route.stats.pod.home++;route.stats.last=value(2);assert.equal(emitted.length,1);
  route.stats.low.home++;route.stats.pod.home++;route.stats.last={...value(3),kind:'low-opaque'};assert.equal(emitted.length,1);
  route.stats.low.home++;route.stats.last={...value(4),kind:'low-opaque'};assert.equal(emitted.length,2);
  route.stats.last=value(5);assert.equal(emitted.length,2,'assignment without success delta is not a receipt');
  assert.equal(route.wrap,wrap);assert.equal(JSON.parse(JSON.stringify(route.stats)).last.path,value(5).path);
});
test('Motion UI distinguishes independent Home work, recovery, and server staging',()=>{
  const source=fs.readFileSync(require.resolve('../ui/pc-boost-settings-20261002.js'),'utf8');
  const start=source.indexOf('function homeMotionSummary('),end=source.indexOf('\nfunction renderConcurrency(',start);
  assert.ok(start>=0&&end>start,'dedicated Motion summary missing');
  const context={};vm.runInNewContext(source.slice(start,end)+';this.summary=homeMotionSummary;',context);
  const result=context.summary({homeMotion:{slots:4},homeMotionQueue:{active:6,homeActive:4,recovering:2,queued:20,serverStagingMb:6144}});
  assert.match(result,/4 Home active/);assert.match(result,/4 slots/);assert.match(result,/2 server recoveries/);
  assert.match(result,/6\.0 GB server staging/);assert.doesNotMatch(result,/6\/4|6\/0/);
  assert.match(context.summary(null),/unavailable/);
  assert.match(source,/number\(worker\.graphicsBusy\).*number\(worker\.graphicsCapacity\)/);
});
