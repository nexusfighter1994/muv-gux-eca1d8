'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {install}=require('../node/home-motion-readiness-batch.cjs');
test('one readiness read per synchronous queue scan, never across scans',()=>{
  let reads=0,enabled=true;
  const validation={ready(){reads++;return enabled;}};
  const queue={stats(){return Array.from({length:2000},()=>validation.ready());},drain(){return this.stats();}};
  const h=install(queue,validation);
  assert.ok(queue.stats().every(Boolean));assert.equal(reads,1);
  enabled=false;assert.ok(queue.drain().every(v=>!v));assert.equal(reads,2);
  enabled=true;assert.equal(validation.ready(),true);assert.equal(reads,3);
  assert.equal(h.stats.saved,3998);h.restore();
});
test('exceptions and nested calls release the synchronous cache',()=>{
  let reads=0,throws=true;
  const validation={ready(){reads++;if(throws)throw Error('read');return true;}};
  const queue={stats(){return validation.ready();},drain(){this.stats();return this.stats();}};
  install(queue,validation);assert.throws(()=>queue.drain(),/read/);
  throws=false;assert.equal(queue.drain(),true);assert.equal(reads,2);
  validation.ready();assert.equal(reads,3);
});
test('no cached readiness survives an await and restore preserves newer owners',async()=>{
  let enabled=true,reads=0;
  const validation={ready(){reads++;return enabled;}};
  const original=validation.ready;
  const queue={stats(){return validation.ready();},async drain(){validation.ready();await Promise.resolve();return validation.ready();}};
  const h=install(queue,validation);const p=queue.drain();enabled=false;
  assert.equal(await p,false);assert.equal(reads,2);
  const newer=()=>false;queue.stats=newer;h.restore();
  assert.equal(queue.stats,newer);assert.equal(validation.ready,original);
});
