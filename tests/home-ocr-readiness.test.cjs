'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ocr = require('../node/home-ocr.cjs');

async function fixture() {
  let time = 100000, enabled = true;
  let response = {ready:true,contract:ocr.CONTRACT};
  const waiters = [{homeKind:'siglip-server',resourceKey:'siglip'},
    {homeKind:'siglip-home',resourceKey:'siglip'},
    {homeKind:'siglip-native-recovery',resourceKey:'siglip'}];
  let drains = 0, probes = 0;
  const queue = {runCallback(){},getScope:s=>s,drain(){drains++;}};
  const handle = ocr.install({queue,client:{request(){}},getScope:()=>null,isRecovery:()=>false,
    isAborted:()=>false,getState:()=>({waiters}),enabled:()=>enabled,send:async()=>{},
    probe:async()=>{probes++;if(response instanceof Error)throw response;return response;},
    now:()=>time,schedule:()=>({unref(){}})});
  await new Promise(setImmediate);
  return {handle,queue,waiters,setTime:v=>time=v,setEnabled:v=>enabled=v,
    setResponse:v=>response=v,get drains(){return drains;},get probes(){return probes;}};
}

test('OCR admission tolerates 90 seconds of API lag, but expires at 120 seconds', async()=>{
  const f = await fixture();
  f.setTime(111000);f.handle.tick();
  assert.equal(f.handle.snapshot().ready,true);
  assert.equal(f.waiters[0].homeKind,'siglip-home-candidate');
  f.setTime(190000);assert.equal(f.handle.snapshot().ready,true);
  f.setTime(219999);assert.equal(f.handle.snapshot().ready,true);
  f.setTime(220000);f.handle.tick();
  assert.equal(f.handle.snapshot().ready,false);
  assert.equal(f.waiters[0].homeKind,'siglip-server');
  assert.equal(f.waiters[1].homeKind,'siglip-home');
  assert.equal(f.waiters[2].homeKind,'siglip-native-recovery');
});

test('one transient transport failure retains only the last authenticated bounded success', async()=>{
  const f = await fixture();f.setTime(104000);f.setResponse(Error('OCR connection reset'));
  await f.handle.probe();f.handle.tick();
  assert.equal(f.handle.snapshot().ready,true);
  assert.equal(f.handle.snapshot().checkedAt,100000);
  f.setTime(220000);assert.equal(f.handle.snapshot().ready,false);
});

test('explicit unready, incompatible contract and rejected authentication invalidate immediately', async()=>{
  for(const response of [{ready:false,contract:ocr.CONTRACT},{ready:true,contract:'wrong'},Error('OCR HTTP 401'),Error('OCR HTTP 403')]) {
    const f = await fixture();f.setResponse(response);await f.handle.probe();f.handle.tick();
    assert.equal(f.handle.snapshot().ready,false);
    assert.equal(f.waiters[0].homeKind,'siglip-server');
  }
});

test('disabled config, future timestamps and stopped handle cannot admit Home OCR', async()=>{
  const f = await fixture();f.setTime(99999);assert.equal(f.handle.snapshot().ready,false);
  f.setTime(100001);f.setEnabled(false);f.handle.tick();assert.equal(f.handle.snapshot().ready,false);
  f.setEnabled(true);assert.equal(f.handle.snapshot().ready,true);
  f.handle.disable();f.handle.tick();assert.equal(f.handle.snapshot().ready,false);
  assert.equal(f.waiters[0].homeKind,'siglip-server');
  assert.equal(f.handle.snapshot().capacity,2);
});

test('hot installation preserves callbacks, counters, timers and admits no work before a valid probe', async()=>{
  const helper=require('../node/home-ocr-readiness.cjs');
  let time=100000,release,requests=0;
  const waiters=[{homeKind:'siglip-server',resourceKey:'siglip'}];
  const stats={completed:73,active:2,fallback:4};
  const callback=()=>{},timer={},healthTimer={};
  const queue={runCallback:callback,drain(){}};
  const handle={stats,timer,healthTimer,probe(){},tick(){},disable(){},
    snapshot:()=>({...stats,capacity:2,health:null,checkedAt:0})};
  const original={...handle};
  const deps={handle,queue,getState:()=>({waiters}),enabled:()=>true,now:()=>time,contract:ocr.CONTRACT,
    probe:()=>{requests++;return new Promise(resolve=>release=resolve);}};
  const owner=helper.install(deps);
  assert.equal(helper.install(deps),owner);
  handle.tick();assert.equal(waiters[0].homeKind,'siglip-server');
  const probe=handle.probe();await handle.probe();assert.equal(requests,1);
  release({ready:true,contract:ocr.CONTRACT});await probe;handle.tick();
  assert.equal(waiters[0].homeKind,'siglip-home-candidate');
  assert.equal(handle.stats,stats);assert.equal(handle.timer,timer);assert.equal(handle.healthTimer,healthTimer);
  assert.equal(queue.runCallback,callback);assert.equal(handle.snapshot().completed,73);
  time=220000;handle.tick();assert.equal(waiters[0].homeKind,'siglip-server');
  owner.restore();assert.equal(handle.snapshot,original.snapshot);assert.equal(handle.tick,original.tick);
  assert.equal(handle.probe,original.probe);assert.equal(handle.disable,original.disable);
});

test('hot installation reuses only an unexpired compatible original success',()=>{
  const helper=require('../node/home-ocr-readiness.cjs');
  for(const checkedAt of [200000,80000,200001,0]){
    const handle={probe(){},tick(){},disable(){},snapshot:()=>({capacity:2,
      health:{ready:true,contract:ocr.CONTRACT},checkedAt})};
    helper.install({handle,queue:{drain(){}},getState:()=>({waiters:[]}),enabled:()=>true,
      probe:async()=>({ready:true,contract:ocr.CONTRACT}),contract:ocr.CONTRACT,now:()=>200000});
    assert.equal(handle.snapshot().ready,checkedAt===200000);
  }
});

test('120 second OCR upgrade layers over live 30 second owner and rolls back without resetting work',()=>{
  const helper=require('../node/home-ocr-readiness.cjs'),previous={version:2,readyMs:30000};
  const oldSnapshot=()=>({ready:false,capacity:2,completed:900,active:2,
    health:{ready:true,contract:ocr.CONTRACT},checkedAt:1000});
  const handle={probe(){},tick(){},disable(){},snapshot:oldSnapshot,__vfReadinessV2:previous};
  const owner=helper.install({handle,queue:{drain(){}},getState:()=>({waiters:[]}),enabled:()=>true,
    probe:async()=>({ready:true,contract:ocr.CONTRACT}),contract:ocr.CONTRACT,now:()=>91000});
  assert.equal(handle.snapshot().ready,true);assert.equal(handle.snapshot().completed,900);
  assert.equal(handle.snapshot().active,2);owner.restore();
  assert.equal(handle.__vfReadinessV2,previous);assert.equal(handle.snapshot,oldSnapshot);
});
