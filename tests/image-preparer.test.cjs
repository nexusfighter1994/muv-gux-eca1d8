'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createImagePreparer,MAX_ACTIVE,PER_REQUEST}=require(path.join(__dirname,'../node/image-preparer.cjs'));

function slowFetcher(stats,ms=20){
  return async candidate=>{stats.active++;stats.max=Math.max(stats.max,stats.active);
    await new Promise(r=>setTimeout(r,ms));stats.active--;return {id:candidate.id};};
}
const candidates=n=>Array.from({length:n},(_,i)=>({id:String(i)}));

test('one request fetches up to 8 images at once and keeps order',async()=>{
  const prepare=createImagePreparer(),stats={active:0,max:0};
  const out=await prepare({candidates:candidates(20),signal:new AbortController().signal,readLimit:()=>20,fetchImage:slowFetcher(stats)});
  assert.equal(stats.max,PER_REQUEST);
  assert.deepEqual(out.map(o=>o.id),candidates(20).map(c=>c.id));
});
test('all requests together stay under 2 x siglipConcurrency (max 48)',async()=>{
  const prepare=createImagePreparer(),stats={active:0,max:0},signal=new AbortController().signal;
  await Promise.all(Array.from({length:10},()=>prepare({candidates:candidates(16),signal,readLimit:()=>3,fetchImage:slowFetcher(stats)})));
  assert.equal(stats.max,6);
  const big={active:0,max:0};
  await Promise.all(Array.from({length:10},()=>prepare({candidates:candidates(16),signal,readLimit:()=>40,fetchImage:slowFetcher(big)})));
  assert.equal(big.max,MAX_ACTIVE);
});
test('a failed image aborts the request and frees its slots',async()=>{
  const prepare=createImagePreparer(),signal=new AbortController().signal;
  await assert.rejects(prepare({candidates:candidates(10),signal,readLimit:()=>20,
    fetchImage:async c=>{if(c.id==='3')throw Error('image type');await new Promise(r=>setTimeout(r,5));return c;}}),/image type/);
  const stats={active:0,max:0};
  await prepare({candidates:candidates(8),signal,readLimit:()=>20,fetchImage:slowFetcher(stats)});
  assert.equal(stats.max,PER_REQUEST);
});
test('an aborted request rejects with the abort reason',async()=>{
  const prepare=createImagePreparer(),controller=new AbortController();
  const run=prepare({candidates:candidates(30),signal:controller.signal,readLimit:()=>1,fetchImage:slowFetcher({active:0,max:0},50)});
  controller.abort(Error('cancelled'));
  await assert.rejects(run,/cancelled/);
});
