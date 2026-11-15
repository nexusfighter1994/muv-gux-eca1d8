import test from 'node:test';
import assert from 'node:assert/strict';
import {createHomeSiglipClient,createHomeSiglipRankSender} from '../node/home-siglip-transport.mjs';
import {createHomeSiglipBufferBudget} from '../node/home-siglip.mjs';
import {createHomeSiglipQueue,attachHomeSiglipRecovery} from '../node/home-siglip.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import fastpath from '../node/siglip-health-fastpath.cjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Home never submits server work on GPU failure or unsupported OCR',async()=>{
  const scope={jobId:'job'};let server=0;
  const client={request:async()=>{server++;return {};}};
  createHomeSiglipClient({client,getScope:()=>scope,rankHome:async()=>null});
  await assert.rejects(client.request('/embed',{method:'POST',body:{candidates:[]}}),{code:'VF_HOME_SIGLIP_FALLBACK'});
  await assert.rejects(client.request('/ocr',{method:'POST',body:{}}),{code:'VF_HOME_SIGLIP_FALLBACK'});
  assert.equal(server,0);
});

test('completed Home task can be polled without server calls, recovery stays native',async()=>{
  let scope={jobId:'job'},recovery=false,legacy=0,native=0;
  const expected={status:'completed',results:[{id:'1',score:.2}]};
  const client={request:async()=>{legacy++;return 'legacy';},__vfNativeSiglipRequest:async()=>{native++;return 'native';}};
  createHomeSiglipClient({client,getScope:()=>scope,isRecovery:()=>recovery,rankHome:async()=>expected,newId:()=> 'task'});
  const created=await client.request('/embed',{method:'POST',body:{candidates:[{id:'1'}]}});
  assert.deepEqual(await client.request('/embed/'+created.task_id),expected);
  assert.equal(legacy,0);assert.equal(native,0);
  scope=null;recovery=true;assert.equal(await client.request('/embed',{method:'POST'}),'native');
  assert.equal(native,1);
  recovery=false;assert.equal(await client.request('/embed',{method:'POST'}),'legacy');
});

test('sender retains model/scoring/input limits and releases bounded buffers',async()=>{
  const budget=createHomeSiglipBufferBudget(),scope={};let sent;
  const health={ready:true,model_id:'google/siglip2-base-patch16-384',model_revision:'f775b65a79762255128c981547af89addcfe0f88',text_modes:['siglip2'],multi_query:true,active_tasks:0,transferLimits:{siglipMaxImageMb:100}};
  const fetcher=async(url,options)=>{
    if(url.endsWith('/health'))return Response.json(health);
    if(url.endsWith('/rank')){sent=JSON.parse(options.body);return Response.json({status:'completed',results:[{id:'1',score:.5}]});}
    return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
  };
  const rank=createHomeSiglipRankSender({getScope:()=>scope,budget,readConfig:()=>({enabled:true,siglipEnabled:true,siglipConcurrency:14}),readToken:()=> 'private-test-token',readTransfer:()=>({siglipMaxImageMb:100}),url:'http://pc',fflow:null,fetcher});
  const result=await rank({query:'query',queries:['q2'],negative_queries:['n'],negative_weight:.5,candidates:[{id:'1',image_url:'https://images/image.png',metadata:{shot_id:1}}]});
  assert.equal(result.results[0].score,.5);assert.equal(sent.candidates[0].image_base64,'AQID');
  assert.deepEqual(sent.queries,['q2']);assert.deepEqual(sent.negative_queries,['n']);
  assert.equal(sent.negative_weight,.5);assert.equal(sent.text_mode,'siglip2');
  assert.equal(budget.stats().reservedBytes,0);assert.equal(scope.pcSubmitted,false);
});

test('PC disappearance cannot start server inference before native RAM admission',async()=>{
  const scope={jobId:'job',nonce:'scope',kind:'siglip-embed',candidate:true};
  const storage=new AsyncLocalStorage(),scopes=new Map([[scope.nonce,scope]]);
  const state={activeTotal:1,activeByResource:new Map([['siglip',1]]),waiters:[]};
  const q=createHomeSiglipQueue({getState:()=>state,getCapacity:()=>14,claim(){},scopes});
  let admit,entered=0,server=0;
  const gate=new Promise(r=>admit=r);
  attachHomeSiglipRecovery(q,{runNative:async(job,fn)=>{await gate;entered++;return fn();},
    runNativeContext:(s,fn)=>storage.run({recovery:true},fn)});
  const expected={status:'completed',results:[{id:'1',score:.5}]};
  const client={request:async()=>{throw Error('legacy route must not run');},
    __vfNativeSiglipRequest:async(path)=>{assert.equal(entered,1);server++;return path==='/embed'?{task_id:'native'}:expected;}};
  createHomeSiglipClient({client,getScope:()=>storage.getStore()?.home?scope:null,
    isRecovery:()=>storage.getStore()?.recovery===true,rankHome:async()=>null});
  const callback=async()=>{const created=await client.request('/embed',{method:'POST',body:{candidates:[{id:'1'}]}});return client.request('/embed/'+created.task_id);};
  callback.toString=()=> '()=>(a.embedAndRank||ZQ)({query:Je,extraQueries:[...tr.slice(1),...mt,g].filter(Boolean),negativeQueries:ce?dQe:[],shots:pr,deadlineTs:Date.now()+12e4})';
  const pending=storage.run({home:true},()=>q.runCallback(scope,callback));
  await new Promise(r=>setTimeout(r,15));assert.equal(server,0);assert.equal(entered,0);
  admit();assert.deepEqual(await pending,expected);assert.equal(server,2);
  q.release(scope,true);assert.equal(q.stats().active,0);
});

test('real hot client preserves old cache and shares counters while using new namespace',async()=>{
  const scope={};let finish;
  const client={request:async()=> 'native'};
  const expected={status:'completed',results:[{id:'1',score:.123456}]};
  createHomeSiglipClient({client,getScope:()=>scope,rankHome:()=>new Promise(r=>finish=r),newId:()=> 'old'});
  const pending=client.request('/embed',{method:'POST',body:{candidates:[{id:'1'}]}});
  const stats=client.__vfHomeSiglipTransport.stats;
  fastpath.installClient({client,createClient:createHomeSiglipClient,getScope:()=>scope,isRecovery:()=>false,rankHome:async()=>expected});
  finish(expected);const old=await pending;
  assert.deepEqual(await client.request('/embed/'+old.task_id),expected);
  const fresh=await client.request('/embed',{method:'POST',body:{candidates:[{id:'1'}]}});
  assert.match(fresh.task_id,/^vfpc-home-fast100-/);
  assert.deepEqual(await client.request('/embed/'+fresh.task_id),expected);
  assert.equal(stats.completed,2);assert.equal(stats.fallback,0);
});

test('cached health still enforces model identity, config and transfer compatibility',async()=>{
  const saved=globalThis.__vfHomeSiglipHealth;
  const budget=createHomeSiglipBufferBudget();let posts=0;
  globalThis.__vfHomeSiglipHealth={snapshot:()=>({checkedAt:Date.now(),health:{ready:true,model_id:'wrong'}})};
  try{
    const rank=createHomeSiglipRankSender({getScope:()=>({}),budget,readConfig:()=>({enabled:true,siglipEnabled:true}),readToken:()=> 'private-test-token',
      readTransfer:()=>({siglipMaxImageMb:100}),url:'http://10.0.3.1:18194',fflow:null,
      fetcher:async()=>{posts++;throw Error('must not post');}});
    assert.equal(await rank({candidates:[]}),null);assert.equal(posts,0);assert.equal(budget.stats().reservedBytes,0);
  }finally{globalThis.__vfHomeSiglipHealth=saved;}
});

test('local fast path preserves original bytes and transfer/buffer/cancellation limits',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vf-rank-')),old=process.env.FFLOW_STORAGE_DIR;
  await fs.mkdir(path.join(root,'outputs'));process.env.FFLOW_STORAGE_DIR=root;
  const bytes=Buffer.alloc(1024,27);await fs.writeFile(path.join(root,'outputs/a.jpg'),bytes);
  const budget=createHomeSiglipBufferBudget(),scope={};let posts=0;
  const fetcher=async(url,options)=>{
    if(url.endsWith('/health'))return Response.json({ready:true,model_id:'google/siglip2-base-patch16-384',model_revision:'f775b65a79762255128c981547af89addcfe0f88',text_modes:['siglip2'],multi_query:true,active_tasks:0,transferLimits:{siglipMaxImageMb:100}});
    assert.ok(url.endsWith('/rank'),'No image HTTP request expected');posts++;
    assert.deepEqual(Buffer.from(JSON.parse(options.body).candidates[0].image_base64,'base64'),bytes);
    return Response.json({status:'completed',results:[{id:'1',score:.5}]});
  };
  try{
    const rank=createHomeSiglipRankSender({getScope:()=>scope,budget,readConfig:()=>({enabled:true,siglipEnabled:true,siglipConcurrency:25}),readToken:()=> 'private-test-token',readTransfer:()=>({siglipMaxImageMb:1}),url:'http://pc',fflow:{baseUrl:()=> 'http://127.0.0.1:8091'},fetcher});
    const body={query:'original',candidates:[{id:'1',image_url:'http://127.0.0.1:8091/v1/download/outputs/a.jpg'}]};
    await rank(body);assert.equal(posts,1);assert.equal(budget.stats().reservedBytes,0);
    await fs.writeFile(path.join(root,'outputs/a.jpg'),Buffer.alloc(2*1024*1024));
    await assert.rejects(rank(body),/image transfer limit/);assert.equal(posts,1);assert.equal(budget.stats().reservedBytes,0);
  }finally{if(old===undefined)delete process.env.FFLOW_STORAGE_DIR;else process.env.FFLOW_STORAGE_DIR=old;await fs.rm(root,{recursive:true,force:true});}
});

test('101 upgrade retains the 100 cache owner and exact counters',async()=>{
  const scope={},client={request:async()=> 'native'},result={status:'completed',results:[]};
  createHomeSiglipClient({client,getScope:()=>scope,rankHome:async()=>result});
  const deps={client,createClient:createHomeSiglipClient,getScope:()=>scope,isRecovery:()=>false,rankHome:async()=>result};
  fastpath.installClient(deps);const old=await client.request('/embed',{method:'POST',body:{candidates:[]}});
  fastpath.installClient({...deps,version:101});const fresh=await client.request('/embed',{method:'POST',body:{candidates:[]}});
  assert.match(fresh.task_id,/fast101-/);assert.deepEqual(await client.request('/embed/'+old.task_id),result);
  assert.deepEqual(await client.request('/embed/'+fresh.task_id),result);assert.equal(client.__vfHomeSiglipTransport.stats.completed,2);
});

test('model status and health probes inside a Home scope stay native, other endpoints stay refused',async()=>{
  const scope={jobId:'job'};const calls=[];
  const client={request:async(p,o)=>{calls.push(p);return {loaded:true,rss_mb:900};}};
  createHomeSiglipClient({client,getScope:()=>scope,rankHome:async()=>null});
  assert.deepEqual(await client.request('/internal/model/status',{timeoutMs:3000}),{loaded:true,rss_mb:900});
  assert.deepEqual(await client.request('/health'),{loaded:true,rss_mb:900});
  assert.deepEqual(calls,['/internal/model/status','/health']);
  await assert.rejects(client.request('/internal/model/unload',{method:'POST',timeoutMs:10000}),{code:'VF_HOME_SIGLIP_FALLBACK'});
  await assert.rejects(client.request('/internal/model/status',{method:'POST'}),{code:'VF_HOME_SIGLIP_FALLBACK'});
  await assert.rejects(client.request('/ocr',{method:'POST',body:{}}),{code:'VF_HOME_SIGLIP_FALLBACK'});
  assert.equal(calls.length,2);
});
