import test from 'node:test';
import assert from 'node:assert/strict';
import {createHomeQueue} from '../node/home-queue.mjs';

function fixture(){
 const state={activeTotal:14,activeByResource:new Map([['ffmpeg',14]]),waiters:[]};
 const claimed=[];let nonce=0;
 const queue=createHomeQueue({getState:()=>state,getCapacity:()=>6,newNonce:()=>String(++nonce),
  memoryGate:()=>true,canClaim:w=>w.homeKind==='video-normalize',
  claim:(w,scope)=>{state.waiters.splice(state.waiters.indexOf(w),1);state.activeTotal++;
   state.activeByResource.set('ffmpeg',state.activeByResource.get('ffmpeg')+1);claimed.push({w,scope});}});
 const add=(jobId,homeKind,priority='a')=>state.waiters.push({jobId,homeKind,priority,
  seq:state.waiters.length,resourceKey:'ffmpeg',opKey:'b_roll_video'});
 return {state,queue,claimed,add};
}

test('historical candidates cannot fill the Home queue ahead of proven direct work',async()=>{
 const f=fixture();
 for(let i=0;i<12;i++)f.add('candidate-'+i,'video-normalize-candidate');
 for(let i=0;i<4;i++)f.add('direct-'+i,'video-normalize','b');
 await f.queue.drain();
 assert.deepEqual(f.claimed.map(x=>x.w.jobId),['candidate-0','candidate-1','direct-0','direct-1','direct-2','direct-3']);
 assert.equal(f.queue.stats().active,6);
 assert.equal(f.queue.serverView(()=>f.state.activeTotal),14);
 assert.equal(f.queue.stats().candidateActive,2);
 for(const item of f.claimed.slice(0,2)){
  assert.equal(item.scope.kind,'video-normalize');assert.equal(item.scope.candidate,true);
  assert.equal(f.queue.validScope(item.scope),true);
 }
});

test('candidate release admits the next candidate in original FIFO order',async()=>{
 const f=fixture();
 for(let i=0;i<5;i++)f.add('candidate-'+i,'video-normalize-candidate');
 await f.queue.drain();assert.equal(f.claimed.length,2);
 f.queue.release(f.claimed[0].scope);await f.queue.drain();
 assert.equal(f.claimed[2].w.jobId,'candidate-2');
 assert.equal(f.queue.stats().candidateActive,2);
});

test('trusted normalizations retain the configured full Home capacity',async()=>{
 const f=fixture();for(let i=0;i<8;i++)f.add('direct-'+i,'video-normalize');
 await f.queue.drain();assert.equal(f.claimed.length,6);
 assert.equal(f.queue.stats().candidateActive,0);
});

test('hot queue replacement preserves existing scope identity for native recovery permits',async()=>{
 const scopes=new Map();const state={waiters:[],activeTotal:0,activeByResource:new Map()};
 const options={getState:()=>state,getCapacity:()=>2,memoryGate:()=>true,
  existingScopes:scopes,claim:()=>{},newNonce:()=>String(scopes.size+1)};
 const original=createHomeQueue(options);
 const scope={jobId:'same-job',nonce:'saved',kind:'video-normalize'};scopes.set(scope.nonce,scope);
 const replacement=createHomeQueue({...options,initialAdmitted:40});
 assert.equal(original.validScope(scope),true);
 assert.equal(replacement.validScope(scope),true);
 assert.equal(replacement.stats().admitted,40);
 replacement.release(scope);assert.equal(original.validScope(scope),false);
});
