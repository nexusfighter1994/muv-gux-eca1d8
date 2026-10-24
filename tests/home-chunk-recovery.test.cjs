'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRecovery}=require('../node/home-chunk-recovery.cjs');
const scope={jobId:'job-parent',nonce:'lease',kind:'composition'};
const failed={data:{status:'failed',error:{message:'Native Home fallback admission timed out'}}};
function setup(overrides={}){
 const calls=[];
 const d={getContext:()=>({leases:new Map([['ffmpeg',{boosted:scope}]])}),validScope:s=>s===scope,isAborted:()=>false,cancel:async id=>calls.push(id),...overrides};
 return {r:createRecovery(d),calls};
}
const pollOptions={engine:'fflow',remoteJobId:'remote-1',timeoutMs:1800000,fetchStatus:async()=>failed};
test('terminal Home admission failure releases first lease and retries chunk once on native path',async()=>{
 const {r}=setup();let attempts=0,released=false;const saved=[];
 const poll=r.wrapPoll(async o=>{await o.fetchStatus();throw Error('terminal');});
 const original=async a=>{attempts++;if(attempts===1){try{return await poll(pollOptions);}finally{released=true;}}
  assert.equal(released,true);assert.equal(r.nativeRecovery(),true);assert.equal(a.checkpoint.remoteTask,null);return 'output';};
 const payload={segments:[{duration:5}],audio_tracks:['voice.wav']};
 assert.equal(await r.wrapChunk(original)({jobId:scope.jobId,payload,checkpoint:{remoteTask:{jobId:'old'},saveRemoteTask:x=>saved.push(x)}}),'output');
 assert.deepEqual(saved,[null]);assert.equal(attempts,2);assert.deepEqual(payload,{segments:[{duration:5}],audio_tracks:['voice.wav']});
});
test('chunk recovery never loops after native failure',async()=>{
 const {r}=setup();let attempts=0;
 const poll=r.wrapPoll(async o=>{await o.fetchStatus();throw Error('terminal');});
 await assert.rejects(r.wrapChunk(async()=>{attempts++;return poll(pollOptions);})({jobId:scope.jobId}),/terminal/);
 assert.equal(attempts,2);
});
test('expired scope and real encoder failures are not silently retried',async()=>{
 for(const config of [{validScope:()=>false},{}]){
  const {r}=setup(config);let attempts=0;
  const status=config.validScope?failed:{data:{status:'failed',error:{message:'invalid codec'}}};
  const poll=r.wrapPoll(async o=>{await o.fetchStatus();throw Error('terminal');});
  await assert.rejects(r.wrapChunk(async()=>{attempts++;return poll({...pollOptions,fetchStatus:async()=>status});})({jobId:scope.jobId}));
  assert.equal(attempts,1);
 }
});
test('canceled parent is never retried',async()=>{
 const {r}=setup({isAborted:()=>true});let attempts=0;
 const poll=r.wrapPoll(async o=>{await o.fetchStatus();throw Error('terminal');});
 await assert.rejects(r.wrapChunk(async()=>{attempts++;return poll(pollOptions);})({jobId:scope.jobId}));assert.equal(attempts,1);
});
test('poll timeout cancels exact remote job but does not pretend cleanup finished',async()=>{
 const {r,calls}=setup();let attempts=0;
 const poll=r.wrapPoll(async o=>{await o.fetchStatus();throw Object.assign(Error('timeout'),{timedOut:true});});
 await assert.rejects(r.wrapChunk(async()=>{attempts++;return poll({...pollOptions,fetchStatus:async()=>({data:{status:'processing'}})});})({jobId:scope.jobId}),/timeout/);
 assert.deepEqual(calls,['remote-1']);assert.equal(attempts,1);
});
test('other providers stay untouched',async()=>{
 const {r,calls}=setup();const original=async()=>{throw Error('network');};
 await assert.rejects(r.wrapPoll(original)({...pollOptions,engine:'clipvault'}));assert.deepEqual(calls,[]);
});
test('native recovery changes only Home routing hint, preserving RAM and resource key',async()=>{
 const {r}=setup();let attempts=0;const seen=[];
 const run=r.wrapRun(async(...args)=>{seen.push(args[3]);return args[2]();});
 const poll=r.wrapPoll(async o=>{await o.fetchStatus();throw Error('terminal');});
 const opts={resourceKey:'fflowComposition',operation:'chunk-composition',contentSeconds:55};
 await r.wrapChunk(async()=>{if(++attempts===1)return poll(pollOptions);return run(scope.jobId,'ffmpeg',()=>42,opts);})({jobId:scope.jobId});
 assert.deepEqual(seen,[{...opts,homeKind:'native-recovery'}]);assert.equal(opts.homeKind,undefined);
});
test('concurrent unrelated work never inherits native recovery routing',async()=>{
 const {r}=setup();let attempts=0;const hints=[];
 const run=r.wrapRun(async(j,l,fn,o)=>{hints.push(o?.homeKind);return fn();});
 const poll=r.wrapPoll(async o=>{await o.fetchStatus();throw Error('terminal');});
 await Promise.all([r.wrapChunk(async()=>{if(++attempts===1)return poll(pollOptions);return run(scope.jobId,'ffmpeg',()=>1,{resourceKey:'fflowComposition'});})({jobId:scope.jobId}),run('b','ffmpeg',()=>2,{resourceKey:'fflowComposition'})]);
 assert.deepEqual(hints,[undefined,'native-recovery']);
});
test('actual resubmitter cannot create a fresh attempt within a chunk poll',async()=>{
 const {createResubmitter}=require('../node/fflow-resubmit.cjs');
 const {r}=setup();let posts=0,attempts=0;
 const client=createResubmitter(async(path,o={})=>o.method==='POST'?(posts++,{data:{job_id:'remote-1'}}):failed,{sleep:async()=>{}});
 const poll=r.wrapPoll(async o=>{const s=await o.fetchStatus();assert.equal(s.data.status,'failed');throw Error('terminal');});
 await r.wrapChunk(async()=>{if(++attempts===2)return 'native-output';await client('/v1/render',{method:'POST',body:{wait_for_results:false}});return poll({...pollOptions,fetchStatus:()=>client('/v1/jobs/remote-1')});})({jobId:scope.jobId});
 assert.equal(posts,1);assert.equal(attempts,2);
});
test('other FFlow retries cannot submit at or after the native poll deadline',async()=>{
 const {createResubmitter}=require('../node/fflow-resubmit.cjs');const {r}=setup();let posts=0;
 const client=createResubmitter(async(path,o={})=>o.method==='POST'?(posts++,{data:{job_id:'remote-1'}}):failed,{sleep:async()=>{}});
 await client('/v1/render',{method:'POST',body:{wait_for_results:false}});
 await r.wrapPoll(o=>o.fetchStatus())({...pollOptions,timeoutMs:0,fetchStatus:()=>client('/v1/jobs/remote-1')});
 assert.equal(posts,1);
});
