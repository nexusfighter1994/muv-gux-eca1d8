import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const home=await import(process.env.VF_SIGLIP_TEST_MODULE?pathToFileURL(process.env.VF_SIGLIP_TEST_MODULE):new URL('../node/home-siglip.mjs',import.meta.url));
const {default:headroom}=await import('../node/siglip-recovery-headroom.cjs');

function fixture(capacity=20) {
  const scopes=new Map(),claimed=[];
  const state={activeTotal:10,activeByResource:new Map([['siglip',10]]),waiters:[]};
  let seq=0,cap=capacity;
  const add=(count,kind='siglip-home')=>{for(let i=0;i<count;i++)state.waiters.push({jobId:'j'+seq,seq:seq++,priority:'a',resourceKey:'siglip',homeKind:kind});};
  const q=home.createHomeSiglipQueue({scopes,getState:()=>state,getCapacity:()=>cap,
    claim(w,s){state.waiters.splice(state.waiters.indexOf(w),1);claimed.push(s);state.activeTotal++;state.activeByResource.set('siglip',state.activeByResource.get('siglip')+1);}});
  return {q,scopes,state,claimed,add,setCap:v=>cap=v};
}

test('native recovery does not monopolize every Home slot; backlog remains bounded',()=>{
  const f=fixture();f.add(100);f.q.drain();
  for(const s of f.claimed)s.recovering=true;
  f.q.drain();
  assert.equal(f.scopes.size,40,'twenty recovering parents do not consume the twenty Home slots');
  assert.equal(f.q.stats().homeActive,20);
  assert.equal(f.q.stats().active,40,'native accounting still excludes all Home parents');
  for(const s of f.scopes.values())s.recovering=true;
  f.q.drain();assert.equal(f.scopes.size,60);
  for(const s of f.scopes.values())s.recovering=true;
  f.q.drain();assert.equal(f.scopes.size,70,'continuous failures cannot grow an unlimited queue');
  f.q.drain();assert.equal(f.scopes.size,70);
});

test('one recovery frees one Home place without exceeding configured Home concurrency',()=>{
  const f=fixture();f.add(100);f.q.drain();f.claimed[0].recovering=true;f.q.drain();
  assert.equal(f.q.stats().homeActive,20);assert.equal(f.scopes.size,21);
  f.q.serverView(()=>assert.equal(f.state.activeTotal,10));
  assert.equal(f.state.activeTotal,31);
  f.q.release(f.claimed[0],true);f.q.release(f.claimed[0],true);
  assert.equal(f.q.stats().completed,1);assert.equal(f.q.stats().admitted,21);
});

test('recovering candidate does not occupy the two OCR preparation places',()=>{
  const f=fixture();f.add(10,'siglip-home-candidate');f.q.drain();
  f.claimed[0].recovering=true;f.q.drain();
  assert.equal(f.scopes.size,3);assert.equal(f.q.stats().candidateActive,2);
});

test('offline state stops intake even when recovery headroom exists',()=>{
  const f=fixture();f.add(100);f.q.drain();for(const s of f.claimed)s.recovering=true;
  f.setCap(0);f.q.drain();assert.equal(f.scopes.size,20);
});

test('existing full recovery backlog leaves configured Home GPU capacity usable',()=>{
  const f=fixture();
  for(let i=0;i<23;i++)f.scopes.set('old'+i,{nonce:'old'+i,jobId:'old'+i,kind:'siglip-embed',recovering:true});
  f.add(100);f.q.drain();
  assert.equal(f.q.stats().homeActive,20);
  assert.equal(f.scopes.size,43);
  assert.equal(f.q.stats().recovering,23);
  for(const s of f.scopes.values())s.recovering=true;
  f.q.drain();assert.equal(f.scopes.size,63);
  for(const s of f.scopes.values())s.recovering=true;
  f.q.drain();assert.equal(f.scopes.size,70,'hard backpressure remains after repeated failures');
  f.q.drain();assert.equal(f.scopes.size,70);
});

test('35 existing recoveries leave all 25 configured Home places usable',()=>{
  const f=fixture(25);
  for(let i=0;i<35;i++)f.scopes.set('old'+i,{nonce:'old'+i,jobId:'old'+i,kind:'siglip-embed',recovering:true});
  f.add(200);f.q.drain();
  assert.equal(f.q.stats().homeActive,25);
  assert.equal(f.scopes.size,60);assert.equal(f.q.stats().recovering,35);
  for(const s of f.scopes.values())s.recovering=true;
  f.q.drain();assert.equal(f.scopes.size,75);f.q.drain();assert.equal(f.scopes.size,75);
  f.setCap(0);f.q.drain();assert.equal(f.scopes.size,75);
});

test('upgrade preserves original scopes and counters and is idempotent',()=>{
  const scopes=new Map([['old',{nonce:'old',jobId:'old',recovering:true}]]);
  const state={waiters:[{jobId:'new',seq:1,priority:'a',resourceKey:'siglip',homeKind:'siglip-home'}]};
  const q={__vfRecoveryHeadroom:{version:2},drain(){},stats(){return{active:scopes.size,admitted:100,completed:90,failed:9};}};
  const deps={scopes,getState:()=>state,getCapacity:()=>20,claim(w,s){state.waiters.splice(0,1);}};
  const old=scopes.get('old');headroom.install(q,deps);const drain=q.drain;
  assert.equal(q.stats().admitted,100);assert.equal(q.stats().completed,90);assert.equal(q.stats().failed,9);
  q.drain();assert.equal(q.stats().admitted,101);assert.equal(scopes.get('old'),old);
  headroom.install(q,deps);assert.equal(q.drain,drain);assert.equal(q.stats().admitted,101);
});
