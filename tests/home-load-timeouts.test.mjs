import test from 'node:test';
import assert from 'node:assert/strict';
import {startHomeSiglipHealth,createHomeSiglipBufferBudget} from '../node/home-siglip.mjs';
import {createHomeSiglipRankSender} from '../node/home-siglip-transport.mjs';
import fast from '../node/siglip-health-fastpath.cjs';
import timeouts from '../node/home-load-timeouts.cjs';

const health={ready:true,device:'cuda',model_id:'google/siglip2-base-patch16-384',model_revision:'f775b65a79762255128c981547af89addcfe0f88',multi_query:true,text_modes:['siglip2'],configured_concurrency:25,active_tasks:0,transferLimits:{siglipMaxImageMb:100}};
const config=()=>({enabled:true,siglipEnabled:true,siglipConcurrency:25});
const next=()=>new Promise(r=>setImmediate(r));
function sender(deps={}){
  return createHomeSiglipRankSender({getScope:()=>({}),budget:createHomeSiglipBufferBudget(),readConfig:config,readToken:()=> 'test-private-token',readTransfer:()=>({siglipMaxImageMb:100}),url:'http://pc',fflow:null,...deps});
}

test('background health gets 120 seconds with bounded readiness freshness',async t=>{
  const times=[];
  t.mock.method(AbortSignal,'timeout',ms=>{times.push(ms);return new AbortController().signal;});
  t.mock.method(globalThis,'fetch',async()=>Response.json(health));
  let clock=1000;
  const h=startHomeSiglipHealth({readConfig:config,readToken:()=> 'test',url:'http://pc',now:()=>clock,schedule:()=>({unref(){}})});
  await next();assert.deepEqual(times,[120000]);assert.equal(h.getCapacity(),25);
  clock=121000;assert.equal(h.getCapacity(),0);
});

test('coalesced health has the same 120 second bound and is not cached after expiry',async t=>{
  const times=[];
  t.mock.method(AbortSignal,'timeout',ms=>{times.push(ms);return new AbortController().signal;});
  const fetcher=fast.createHealthFetch({url:'http://pc',readSnapshot:()=>null,fetcher:async()=>Response.json(health)});
  await Promise.all([fetcher('http://pc/health'),fetcher('http://pc/health')]);
  assert.deepEqual(times,[120000]);
  await fetcher('http://pc/health');assert.deepEqual(times,[120000,120000]);
});

test('Home ranking survives the old 120s bound but aborts once at 600s and releases buffers',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const budget=createHomeSiglipBufferBudget(),scope={};let posts=0,requestSignal;
  const rank=sender({budget,getScope:()=>scope,fetcher:async(url,opts)=>{
    if(url.endsWith('/health'))return Response.json(health);
    posts++;requestSignal=opts.signal;
    return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}));
  }});
  const result=rank({query:'original',candidates:[]});
  const rejected=assert.rejects(result,{name:'AbortError'});
  await next();assert.equal(posts,1);
  t.mock.timers.tick(120000);await next();assert.equal(requestSignal.aborted,false);
  t.mock.timers.tick(479999);await next();assert.equal(requestSignal.aborted,false);
  t.mock.timers.tick(1);await rejected;
  assert.equal(posts,1);assert.equal(budget.stats().reservedBytes,0);assert.equal(scope.pcSubmitted,false);
});

test('image reads have 80 seconds and sender health has 120 seconds',async t=>{
  const times=[];
  t.mock.method(AbortSignal,'timeout',ms=>{times.push(ms);return new AbortController().signal;});
  const rank=sender({fetcher:async(url)=>{
    if(url.endsWith('/health'))return Response.json(health);
    if(url.endsWith('/rank'))return Response.json({status:'completed',results:[{id:'1',score:.25}]});
    return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
  }});
  await rank({query:'original',candidates:[{id:'1',image_url:'https://example.test/image.png'}]});
  assert.deepEqual(times,[120000,120000,180000]);
});

test('caller cancellation wins immediately over the enlarged Home deadline',async()=>{
  const abort=new AbortController(),scope={signal:abort.signal},budget=createHomeSiglipBufferBudget();let posts=0;
  const reason=Error('candidate cancelled');
  const rank=sender({budget,getScope:()=>scope,fetcher:async(url,opts)=>{
    if(url.endsWith('/health'))return Response.json(health);
    posts++;return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}));
  }});
  const result=rank({candidates:[]});const check=assert.rejects(result,e=>e===reason);
  await next();abort.abort(reason);await check;
  assert.equal(posts,1);assert.equal(budget.stats().reservedBytes,0);
});

test('hot health upgrade changes only legacy 5s calls and refuses unsafe rollback',async()=>{
  const seen=[],workers={health:async opts=>{seen.push(opts);return {ready:false};},sync:()=> 'unchanged'};
  const original=workers.health,sync=workers.sync,handle=timeouts.installWorkerHealth(workers);
  assert.equal(timeouts.installWorkerHealth(workers),handle);
  await workers.health({deadlineMs:5000});await workers.health({deadlineMs:600});await workers.health();
  assert.deepEqual(seen,[{deadlineMs:120000},{deadlineMs:600},{}]);assert.equal(workers.sync,sync);
  handle.restore();assert.equal(workers.health,original);
  const again=timeouts.installWorkerHealth(workers);workers.health=()=>{};
  assert.throws(()=>again.restore(),/ownership changed/);
});

test('hot health seed keeps its true age; slow probes never overlap or invent freshness',async t=>{
  let clock=10000,probe,release,calls=0,fail=false;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;await new Promise(r=>release=r);
    if(fail)throw Error('offline');return Response.json(health);
  });
  const h=startHomeSiglipHealth({readConfig:config,readToken:()=> 'test',url:'http://pc',now:()=>clock,
    schedule:fn=>{probe=fn;return {unref(){}};},initialSnapshot:{health,checkedAt:1000}});
  assert.equal(h.snapshot().checkedAt,1000);assert.equal(h.getCapacity(),25);
  await probe();await probe();assert.equal(calls,1);
  clock=121000;assert.equal(h.getCapacity(),0);
  release();await next();assert.equal(h.snapshot().checkedAt,121000);assert.equal(h.getCapacity(),25);
  fail=true;const pending=probe();release();await pending;
  clock=241000;assert.equal(h.getCapacity(),0);assert.equal(h.snapshot().checkedAt,121000);
});

test('upgrade preserves old worker wrapper and caller-specific short deadlines',async()=>{
  const seen=[],old={healthMs:24000};
  const original=async options=>{seen.push(options);return {ready:false};};
  const workers={health:original,__vfLoadHealth106:old};
  const h=timeouts.installWorkerHealth(workers);
  await workers.health({deadlineMs:24000});await workers.health({deadlineMs:900});
  assert.deepEqual(seen,[{deadlineMs:120000},{deadlineMs:900}]);
  assert.equal(workers.__vfLoadHealth106,old);
  h.restore();assert.equal(workers.health,original);assert.equal(workers.__vfLoadHealth106,old);
});

test('long health timeout still aborts the real pending probe at the exact bound',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(AbortSignal,'timeout',ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
  let signal;
  t.mock.method(globalThis,'fetch',async(url,opts)=>{
    signal=opts.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  startHomeSiglipHealth({readConfig:config,readToken:()=> 'test',url:'http://pc',schedule:()=>({unref(){}})});
  t.mock.timers.tick(119999);assert.equal(signal.aborted,false);
  t.mock.timers.tick(1);await next();assert.equal(signal.aborted,true);
});

test('auth rejection, wrong model and known refused connection revoke health immediately',async t=>{
  let reply;
  t.mock.method(globalThis,'fetch',async()=>{
    if(reply instanceof Error)throw reply;
    return reply;
  });
  for(const value of [new Response('',{status:401}),new Response('',{status:403}),
    Response.json({...health,model_revision:'wrong'}),Object.assign(Error('refused'),{cause:{code:'ECONNREFUSED'}})]){
    reply=value;
    const h=startHomeSiglipHealth({readConfig:config,readToken:()=> 'test',url:'http://pc',now:()=>90000,
      schedule:()=>({unref(){}}),initialSnapshot:{health,checkedAt:1000}});
    await next();assert.equal(h.getCapacity(),0);assert.equal(h.snapshot().checkedAt,0);
  }
});
