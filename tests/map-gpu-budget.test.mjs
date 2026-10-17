import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapHook} from '../node/home-graphics/map-offload/hook.mjs';
import {createMotionHook} from '../node/home-graphics/motion-offload/hook.mjs';
const params={fps:24,width:1920,height:1080,frames:120,markers:[]};
const endpoint='http://127.0.0.1:18191';
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'map-budget-'));try{return await fn(dir)}finally{await fs.rm(dir,{recursive:true,force:true})}}
test('a slow map GPU attempt retains at least 60 percent of the original CPU budget',async()=>fixture(async dir=>{
  const now=Date.now;let elapsed=0,posted;
  Date.now=()=>now()+elapsed;
  try{
    const options={params,look:'modern',language:'English',outputPath:path.join(dir,'out.mp4'),timeoutMs:300000};
    const before=JSON.stringify(options);
    const hook=createMapHook(async remaining=>{assert.deepEqual(remaining.params,params);assert.equal(remaining.look,'modern');assert(remaining.timeoutMs>=179000,'CPU recovery must retain roughly 180 seconds');assert(remaining.timeoutMs<=300000);return {outputPath:'native'}},{endpoint,token:'test',contract:'map-budget',permitted:()=>true,workDir:dir,fetchImpl:async(_url,init)=>{
      if(init?.method==='POST'){posted=JSON.parse(init.body);elapsed+=posted.timeoutMs;throw Error('GPU timed out')}
      return Response.json(init?.method==='DELETE'?{terminated:true}:{})
    }});
    assert.deepEqual(await hook(options),{outputPath:'native'});assert(posted.timeoutMs<=120000);assert.equal(JSON.stringify(options),before);
  }finally{Date.now=now}
}));
test('Map health stall is aborted within five seconds and falls back without a render POST',{timeout:8000},async()=>fixture(async dir=>{
  let posts=0,cpu=0;const start=performance.now();
  const hook=createMapHook(async remaining=>{cpu++;assert(remaining.timeoutMs>290000);return {outputPath:'native'}},{endpoint,token:'test',contract:'health-stall',permitted:()=>true,workDir:dir,fetchImpl:async(_url,init)=>{
    if(init?.method==='POST')posts++;
    await new Promise((resolve,reject)=>{if(init.signal.aborted)reject(init.signal.reason);else init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})})
  }});
  assert.deepEqual(await hook({params,look:'modern',outputPath:path.join(dir,'out.mp4'),timeoutMs:300000}),{outputPath:'native'});
  assert.equal(posts,0);assert.equal(cpu,1);assert(performance.now()-start<6500);
}));
test('ordinary Motion default deadline and remaining-budget behavior stay unchanged',async()=>fixture(async dir=>{
  const now=Date.now;let elapsed=0;Date.now=()=>now()+elapsed;
  try{
    const hook=createMotionHook(async o=>{assert(o.timeoutMs<=30000&&o.timeoutMs>29000);return 'native'},{endpoint,token:'test',contract:'motion-original',permitted:()=>true,fetchImpl:async(_url,init)=>{if(init?.method==='POST'){elapsed+=270000;throw Error('drop')}return Response.json(init?.method==='DELETE'?{terminated:true}:{})}});
    assert.equal(await hook({assets:[],targetPath:path.join(dir,'out.mp4'),timeoutMs:300000},{duration:1}),'native');
  }finally{Date.now=now}
}));
test('unsupported map shape and pre-cancel never submit work remotely',async()=>{
  let posts=0,cpu=0;const hook=createMapHook(async options=>{cpu++;return options},{endpoint,token:'test',contract:'unsupported',permitted:()=>true,fetchImpl:async()=>{posts++;throw Error('unexpected')}});
  const original={params:{...params,fps:30},look:'modern',timeoutMs:300000};assert.equal(await hook(original),original);
  const c=new AbortController();c.abort(Error('original cancelled'));await assert.rejects(hook({params,signal:c.signal}),/original cancelled/);assert.equal(cpu,1);assert.equal(posts,0);
});
test('parent cancellation during health cannot create a CPU retry',async()=>fixture(async dir=>{
  const controller=new AbortController();let cpu=0;
  const hook=createMapHook(async()=>{cpu++;return {outputPath:'native'}},{endpoint,token:'test',contract:'map-abort-health',permitted:()=>true,workDir:dir,fetchImpl:async(_url,init)=>{
    queueMicrotask(()=>controller.abort(Error('native job cancelled')));
    await new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
  }});
  await assert.rejects(hook({params,look:'modern',outputPath:path.join(dir,'out.mp4'),timeoutMs:300000,signal:controller.signal}),/native job cancelled/);assert.equal(cpu,0);
}));
test('network loss requests owned cleanup before remaining-budget CPU recovery',async()=>fixture(async dir=>{
  const calls=[];let original;
  const hook=createMapHook(async options=>{calls.push('cpu');assert.equal(options.signal,original.signal);assert(options.timeoutMs<=300000&&options.timeoutMs>299000);assert.deepEqual(options.params,original.params);return {outputPath:'native'}},{endpoint,token:'test',contract:'map-owned-cleanup',permitted:()=>true,workDir:dir,fetchImpl:async(url,init)=>{
    calls.push(init?.method??'GET');if(init?.method==='POST'){const payload=JSON.parse(init.body);assert.deepEqual(payload.params,params);assert.equal(payload.look,'paper');assert.equal(payload.language,'German');throw Error('PC disconnected')}
    return Response.json(init?.method==='DELETE'?{terminated:true}:{})
  }});
  original={params,look:'paper',language:'German',outputPath:path.join(dir,'out.mp4'),timeoutMs:300000,signal:new AbortController().signal};
  assert.deepEqual(await hook(original),{outputPath:'native'});assert.deepEqual(calls,['GET','POST','DELETE','cpu']);
}));
test('unconfirmed remote cleanup prevents another remote submit but allows counted native recovery',async()=>fixture(async dir=>{
  let cpu=0,requests=0;const options={params,look:'modern',outputPath:path.join(dir,'out.mp4'),timeoutMs:300000};
  const config={endpoint,token:'test',contract:'map-no-ack-quarantine',permitted:()=>true,workDir:dir,fetchImpl:async(_url,init)=>{requests++;if(init?.method==='POST')throw Error('response lost');return init?.method==='DELETE'?new Response('{}',{status:503}):Response.json({})}};
  const native=async()=>{cpu++;return {outputPath:'native'}};
  await createMapHook(native,config)(options);const before=requests;await createMapHook(native,config)(options);assert.equal(cpu,2);assert.equal(requests,before);
}));
test('GPU deadline plus cleanup time is deducted from the original CPU deadline',async()=>fixture(async dir=>{
  const now=Date.now;let elapsed=0;Date.now=()=>now()+elapsed;
  try{
    const hook=createMapHook(async options=>{assert(options.timeoutMs<=168000&&options.timeoutMs>167000);return {outputPath:'native'}},{endpoint,token:'test',contract:'map-cleanup-budget',permitted:()=>true,workDir:dir,fetchImpl:async(_url,init)=>{if(init?.method==='POST'){elapsed+=JSON.parse(init.body).timeoutMs;throw Error('deadline')}if(init?.method==='DELETE')elapsed+=12000;return Response.json(init?.method==='DELETE'?{terminated:true}:{})}});
    assert.deepEqual(await hook({params,look:'modern',outputPath:path.join(dir,'out.mp4'),timeoutMs:300000}),{outputPath:'native'});
  }finally{Date.now=now}
}));
