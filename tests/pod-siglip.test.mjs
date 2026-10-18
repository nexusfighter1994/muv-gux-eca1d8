import test from 'node:test';
import assert from 'node:assert/strict';
import {createPodSiglip,combineRank,MODEL_ID,MODEL_REVISION} from '../node/runpod/pod-siglip.mjs';

const ready={ready:true,device:'cuda',model_id:MODEL_ID,model_revision:MODEL_REVISION,multi_query:true,configured_concurrency:4,active_tasks:1};
const json=value=>({ok:true,json:async()=>value});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function pod({backend={id:'p1',endpoint:'https://p1-8080.proxy.runpod.net',token:'t'.repeat(40)},health=ready,clock={t:1000},sender}={}){
  const burst={value:backend};const calls=[];
  const created=[];
  const instance=createPodSiglip({getBurst:()=>({backend:()=>burst.value}),getScope:()=>({}),budget:{},readTransfer:()=>({}),
    fetcher:async(url,options)=>{calls.push({url,auth:options.headers.Authorization});return json(health);},
    now:()=>clock.t,schedule:()=>null,createRankSender:options=>{created.push(options);return sender||(async()=>({status:'completed'}));}});
  return {instance,burst,calls,created,clock};
}

test('pod SigLIP capacity is configured minus active slots, only for a ready pod',async()=>{
  const p=pod();await flush();
  assert.equal(p.calls[0].url,'https://p1-8080.proxy.runpod.net/siglip/health');
  assert.equal(p.calls[0].auth,'Bearer '+'t'.repeat(40));
  assert.equal(p.instance.capacity(),3);
  p.clock.t+=10000;assert.equal(p.instance.capacity(),0,'stale health');
  p.clock.t-=10000;p.burst.value={...p.burst.value,id:'p2'};assert.equal(p.instance.capacity(),0,'pod changed');
  p.burst.value=null;assert.equal(p.instance.capacity(),0,'no pod');
});

test('pod SigLIP refuses CPU or other models',async()=>{
  for(const health of [{...ready,device:'cpu'},{...ready,model_revision:'x'},{...ready,ready:false},{...ready,multi_query:false}]){
    const p=pod({health});await flush();assert.equal(p.instance.capacity(),0);
  }
});

test('pod rank uses the Home sender with pod endpoint and token',async()=>{
  const p=pod();await flush();
  const result=await p.instance.rank({candidates:[]});
  assert.equal(result.status,'completed');
  const options=p.created[0];
  assert.equal(options.url,'https://p1-8080.proxy.runpod.net/siglip');
  assert.equal(options.readToken(),'t'.repeat(40));
  assert.deepEqual(options.readConfig(),{enabled:true,siglipEnabled:true,siglipConcurrency:4});
  assert.equal(p.instance.stats.ranked,1);
  p.burst.value=null;
  assert.equal(await p.instance.rank({candidates:[]}),null);
  assert.equal(p.instance.stats.unavailable,1);
});

test('combined rank: Home first while it has room, pod second, and the reverse',async()=>{
  const order=[];
  const home=async()=>{order.push('home');return null;},podRank={rank:async()=>{order.push('pod');return {status:'completed',by:'pod'};}};
  let homeCap=2;
  const rank=combineRank({rankHome:home,homeCapacity:()=>homeCap,pod:podRank});
  assert.equal((await rank({})).by,'pod');assert.deepEqual(order,['home','pod']);
  order.length=0;homeCap=0;
  assert.equal((await rank({})).by,'pod');assert.deepEqual(order,['pod']);
  order.length=0;
  const failing={rank:async()=>{order.push('pod');throw Error('pod down');}};
  const homeOk=async()=>{order.push('home');return {by:'home'};};
  assert.equal((await combineRank({rankHome:homeOk,homeCapacity:()=>0,pod:failing})({})).by,'home');
  assert.deepEqual(order,['pod','home']);
});

test('combined rank keeps Home errors visible when Home went first',async()=>{
  const rank=combineRank({rankHome:async()=>{throw Error('invalid GPU ranking');},homeCapacity:()=>1,pod:{rank:async()=>({})}});
  await assert.rejects(rank({}),/invalid GPU ranking/);
});
