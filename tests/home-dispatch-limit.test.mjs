import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let mod;
try { mod = require('../node/home-dispatch-limit.cjs'); } catch { mod = {}; }

test('independent dispatch limit allows forty while encoders remain eighteen plus fourteen', () => {
  assert.equal(typeof mod.dispatchCapacity, 'function');
  const health = {ready:true, capacity:32, checkedAt:1000};
  assert.equal(mod.dispatchCapacity(health, 40, 2000), 40);
  assert.equal(health.capacity, 32);
  assert.equal(mod.dispatchCapacity(health, 0, 2000), 32);
});
test('offline, zero capacity and stale health never admit work', () => {
  for (const health of [null, {ready:false,capacity:32,checkedAt:1000},
    {ready:true,capacity:0,checkedAt:1000}, {ready:true,capacity:32,checkedAt:0}]) {
    assert.equal(mod.dispatchCapacity(health,40,46000),0);
  }
});
test('invalid limits do not enlarge automatic capacity', () => {
  const health={ready:true,capacity:32,checkedAt:1000};
  for(const limit of [undefined,-1,51,1.5,'40',NaN])
    assert.equal(mod.dispatchCapacity(health,limit,2000),32);
  assert.equal(mod.dispatchCapacity(health,20,2000),20);
});
test('runtime setting is bounded, cached and defaults to automatic', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vf-dispatch-'));
  const file=path.join(dir,'limit.json');let now=1000;
  try {
    const read=mod.createLimitReader({file,now:()=>now});
    assert.equal(read(),0);
    fs.writeFileSync(file,JSON.stringify({slots:40}));now+=1100;
    assert.equal(read(),40);
    fs.writeFileSync(file,JSON.stringify({slots:999}));now+=1100;
    assert.equal(read(),0);
  } finally { fs.rmSync(dir,{recursive:true}); }
});
test('hot shim preserves accessor, timestamps and existing scopes, and installs once', () => {
  let health={ready:true,capacity:32,checkedAt:1000};
  const target={__vfHomeQueue:{scope:'unchanged'}};
  Object.defineProperty(target,'__vfHomeCapabilities',{configurable:true,
    get:()=>health,set:value=>{health=value;}});
  const result=mod.installHotDispatchLimit({target,readLimit:()=>40,now:()=>2000});
  assert.equal(target.__vfHomeCapabilities.capacity,40);
  assert.equal(target.__vfHomeCapabilities.checkedAt,1000);
  assert.equal(target.__vfHomeQueue.scope,'unchanged');
  assert.equal(mod.installHotDispatchLimit({target}),result);
  target.__vfHomeCapabilities={ready:false,capacity:0,checkedAt:2000};
  assert.equal(target.__vfHomeCapabilities.capacity,0);
  assert.equal(health.ready,false);
});
test('hot shim and cold admission use the same capacity function', () => {
  const source=fs.readFileSync(new URL('../node/home-queue.mjs',import.meta.url),'utf8');
  assert.match(source,/homeDispatch\.dispatchCapacity\(health,homeDispatch\.readLimit\(\)\)/);
});
