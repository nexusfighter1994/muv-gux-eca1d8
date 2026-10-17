import test from 'node:test';
import assert from 'node:assert/strict';
import {createHomeSiglipClient,createHomeSiglipRankSender} from '../node/home-siglip-transport.mjs';
import {createHomeSiglipBufferBudget} from '../node/home-siglip.mjs';
import {createHomeSiglipQueue,attachHomeSiglipRecovery} from '../node/home-siglip.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';

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
