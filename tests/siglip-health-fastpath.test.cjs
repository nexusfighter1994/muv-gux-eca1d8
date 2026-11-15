const test=require('node:test');
const assert=require('node:assert/strict');
const fast=require('../node/siglip-health-fastpath.cjs');

test('fresh same-endpoint health avoids redundant network round trip and clones responses',async()=>{
  let calls=0;const h={ready:true,model_id:'same',active_tasks:1};
  const fetcher=fast.createHealthFetch({url:'http://pc',readSnapshot:()=>({url:'http://pc',checkedAt:1000,health:h}),now:()=>4000,
    fetcher:async()=>{calls++;return Response.json({native:true});}});
  assert.deepEqual(await(await fetcher('http://pc/health')).json(),h);
  assert.deepEqual(await(await fetcher('http://pc/health')).json(),h);
  assert.equal(calls,0);
  await fetcher('http://pc/rank',{method:'POST',body:'original'});assert.equal(calls,1);
});

test('stale, future, wrong-origin, non-ready and missing health retain native probe',async()=>{
  for(const snapshot of [null,{url:'http://pc',checkedAt:1000,health:{ready:true}},
    {url:'http://pc',checkedAt:7000,health:{ready:true}},
    {url:'http://other',checkedAt:5500,health:{ready:true}},
    {url:'http://pc',checkedAt:5500,health:{ready:false}}]){
    let calls=0;const fetcher=fast.createHealthFetch({url:'http://pc',readSnapshot:()=>snapshot,now:()=>6000,
      fetcher:async()=>{calls++;return Response.json({original:true});}});
    assert.deepEqual(await(await fetcher('http://pc/health')).json(),{original:true});assert.equal(calls,1);
  }
});

test('aborted cached health preserves the exact reason and never dispatches',async()=>{
  const c=new AbortController(),reason=Error('cancel');c.abort(reason);
  const fetcher=fast.createHealthFetch({url:'http://pc',readSnapshot:()=>({url:'http://pc',checkedAt:1000,health:{ready:true}}),now:()=>2000,
    fetcher:async()=>{throw Error('should not fetch');}});
  await assert.rejects(fetcher('http://pc/health',{signal:c.signal}),e=>e===reason);
});

test('simultaneous stale-health consumers share one probe without sharing cancellation',async()=>{
  let calls=0,finish;
  const fetcher=fast.createHealthFetch({url:'http://pc',readSnapshot:()=>null,fetcher:async()=>{
    calls++;await new Promise(r=>finish=r);return Response.json({ready:true});
  }});
  const c=new AbortController(),a=fetcher('http://pc/health',{signal:c.signal});
  const pending=Array.from({length:24},()=>fetcher('http://pc/health'));
  c.abort();await assert.rejects(a);assert.equal(calls,1);finish();
  for(const response of await Promise.all(pending))assert.deepEqual(await response.json(),{ready:true});
});

test('failed shared probe is not cached and credentials are never shared',async()=>{
  let calls=0;
  const fetcher=fast.createHealthFetch({url:'http://pc',readSnapshot:()=>null,fetcher:async()=>{calls++;throw Error('offline');}});
  const results=await Promise.allSettled(Array.from({length:25},()=>fetcher('http://pc/health')));
  assert.ok(results.every(r=>r.status==='rejected'));assert.equal(calls,1);
  await assert.rejects(fetcher('http://pc/health'));assert.equal(calls,2);
  await Promise.allSettled(['a','b'].map(authorization=>fetcher('http://pc/health',{headers:{authorization}})));
  assert.equal(calls,4);
});

test('hot install retains old polls, OCR, recovery, stats and in-flight responses',async()=>{
  let scope={},recovery=false;const stats={completed:4,fallback:2,lastReason:null};
  let oldCalls=0,newCalls=0;
  const original=async path=>{oldCalls++;return 'old:'+path;};
  const client={request:original,__vfHomeSiglipTransport:{stats},__vfNativeSiglipRequest:original};
  const createClient=({client,stats:s,rankHome,newId})=>{
    assert.equal(s,stats);client.request=async path=>{newCalls++;if(path==='/embed'){await rankHome();s.completed++;return{task_id:'vfpc-home-'+newId()};}return'new-result';};
  };
  const installed=fast.installClient({client,createClient,getScope:()=>scope,isRecovery:()=>recovery,rankHome:async()=>({ok:true})});
  const result=await client.request('/embed',{method:'POST'});
  assert.match(result.task_id,/^vfpc-home-fast100-/);
  assert.equal(await client.request('/embed/'+result.task_id),'new-result');
  assert.equal(await client.request('/embed/vfpc-home-old'),'old:/embed/vfpc-home-old');
  assert.equal(await client.request('/ocr',{method:'POST'}),'old:/ocr');
  recovery=true;assert.equal(await client.request('/embed',{method:'POST'}),'old:/embed');
  recovery=false;scope=null;assert.equal(await client.request('/embed',{method:'POST'}),'old:/embed');
  assert.equal(stats.completed,5);assert.equal(stats.fallback,2);assert.equal(newCalls,2);assert.equal(oldCalls,4);
  assert.equal(client.__vfHomeSiglipTransport.stats,stats);
  installed.restore();assert.equal(client.request,original);
});
