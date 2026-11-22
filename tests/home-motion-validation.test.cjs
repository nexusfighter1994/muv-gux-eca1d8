'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const m=require('../node/home-motion-validation.cjs');
const payload={compositionHtml:'<main>hello</main>',assets:[],fps:24,resolution:'1920x1080'};
const result={valid:true,issues:[],warnings:[],raw:{},diagnostics:{},failureType:null};
function fixture(send,extra={}) {
  const calls=[];
  const queue={ownsCurrent:()=>true,native:async fn=>{calls.push('counted-native');return fn();}};
  const handle=m.create({queue,send,enabled:()=>true,getSignal:()=>undefined,isAborted:()=>false,...extra});
  const native=async()=>{calls.push('native');return 'native-result';};
  return {handle,calls,native};
}
test('valid native verdict preserved and counted as Home',async()=>{
  const f=fixture(async()=>result);
  assert.deepEqual(await f.handle.run(f.native,payload,{jobId:'one'}),result);
  assert.equal(f.handle.snapshot().completed,1);assert.deepEqual(f.calls,[]);
});
test('quality rejection is never hidden with a retry',async()=>{
  const verdict={...result,valid:false,issues:[{code:'reveal_incomplete',message:'text not revealed'}]};
  const f=fixture(async()=>verdict);
  assert.deepEqual(await f.handle.run(f.native,payload,{jobId:'one'}),verdict);
  assert.deepEqual(f.calls,[]);assert.equal(f.handle.snapshot().rejected,1);
});
test('native advisory warnings remain successful; infrastructure recovers',async()=>{
  const verdict={...result,issues:[{severity:'warning',code:'contrast'}]};
  const f=fixture(async()=>verdict);
  assert.deepEqual(await f.handle.run(f.native,payload,{jobId:'one'}),verdict);
  const g=fixture(async()=>({...result,valid:false,issues:[{code:'hyperframes_timeout'}],failureType:'infrastructure'}));
  assert.equal(await g.handle.run(g.native,payload,{jobId:'one'}),'native-result');
});
test('transport error uses counted original native callback exactly once',async()=>{
  const f=fixture(async()=>{throw Error('offline');});
  assert.equal(await f.handle.run(f.native,payload,{jobId:'one'}),'native-result');
  assert.deepEqual(f.calls,['counted-native','native']);
});
test('malformed/contradictory responses fail closed',async()=>{
  for(const response of [{valid:true},{...result,valid:true,issues:['bad']},null]){
    const f=fixture(async()=>response);
    assert.equal(await f.handle.run(f.native,payload,{jobId:'one'}),'native-result');
    assert.deepEqual(f.calls,['counted-native','native']);
  }
});
test('native admission never becomes uncounted offload',async()=>{
  const f=fixture(async()=>{throw Error('must not send');},{queue:{ownsCurrent:()=>false}});
  assert.equal(await f.handle.run(f.native,payload,{jobId:'one'}),'native-result');assert.deepEqual(f.calls,['native']);
});
test('caller abort never starts native fallback',async()=>{
  const c=new AbortController();
  const f=fixture(async()=>{c.abort(Error('cancelled'));throw Error('closed');},{getSignal:()=>c.signal});
  await assert.rejects(f.handle.run(f.native,payload,{jobId:'one'}),/cancelled/);
  assert.deepEqual(f.calls,[]);assert.equal(f.handle.snapshot().active,0);
});
test('unsupported options are preserved by native execution',async()=>{
  const f=fixture(async()=>{throw Error('must not send');});
  assert.equal(await f.handle.run(f.native,{...payload,unknown:true},{jobId:'one'}),'native-result');
  assert.deepEqual(f.calls,['counted-native','native']);
});
test('health contract and freshness are required',()=>{
  const f=fixture(async()=>result);
  assert.equal(f.handle.ready(),false);
  f.handle.setHealth({ready:true,contract:m.CONTRACT,capacity:2,active:0});assert.equal(f.handle.ready(),true);
  f.handle.setHealth({ready:true,contract:'wrong',capacity:2});assert.equal(f.handle.ready(),false);
  f.handle.setHealth({ready:true,contract:m.CONTRACT,capacity:4});assert.equal(f.handle.ready(),true);assert.equal(f.handle.capacity(),4);
  assert.equal(f.handle.snapshot().capacity,4);
  f.handle.setHealth({ready:true,contract:m.CONTRACT,capacity:9});assert.equal(f.handle.ready(),false);assert.equal(f.handle.capacity(),2);
});
