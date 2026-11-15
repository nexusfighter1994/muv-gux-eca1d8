import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import cp from 'node:child_process';
import {once} from 'node:events';
import * as acorn from './helpers/acorn.mjs';

const source=fs.readFileSync(new URL('../node/home-graphics/motion-offload/alpha-worker.mjs',import.meta.url),'utf8');
const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'});
function declaration(name) {
  const node=ast.body.map(x=>x.declaration||x).find(x=>x.type==='FunctionDeclaration'&&x.id.name===name);
  assert.ok(node,name);return source.slice(node.start,node.end);
}
function fixture() {
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  const signals=[];
  child.kill=signal=>{signals.push(signal||'SIGTERM');if(signal==='SIGKILL')queueMicrotask(()=>child.emit('close',null));return true;};
  const scan=vm.runInNewContext('('+declaration('scanAlpha')+')',{
    cp:{spawn:()=>child},Error,alphaExtrema:(b,min,max)=>({min:0,max:255}),
    setTimeout:(fn)=>setTimeout(fn,15),clearTimeout,
  });
  return {child,signals,scan};
}
async function observe(promise) {
  let timer;
  try{return await Promise.race([promise.then(v=>({value:v}),e=>({error:e.message})),new Promise(r=>{timer=setTimeout(()=>r({pending:true}),100);})]);}
  finally{clearTimeout(timer);}
}
test('decode deadline terminates a verifier that ignores SIGTERM',async()=>{
  const f=fixture();const promise=f.scan('owned.mov',1,'ffmpeg');
  try{const result=await observe(promise);assert.equal(result.error,'alpha decode deadline');assert.deepEqual(f.signals,['SIGKILL']);}
  finally{f.child.emit('close',null);await promise.catch(()=>{});}
});
test('parent abort terminates only the owned verifier and settles',async()=>{
  const f=fixture(),controller=new AbortController();const promise=f.scan('owned.mov',1,'ffmpeg',controller.signal);
  controller.abort(Error('job ended'));
  try{const result=await observe(promise);assert.equal(result.error,'job ended');assert.equal(f.signals[0],'SIGKILL');}
  finally{f.child.emit('close',null);await promise.catch(()=>{});}
});
test('successful full alpha decode retains the same contract',async()=>{
  const f=fixture();const promise=f.scan('owned.mov',1,'ffmpeg');
  f.child.stdout.emit('data',Buffer.alloc(1920*1080));f.child.emit('close',0);
  const result=await promise;assert.equal(result.pixels,1920*1080);assert.equal(result.frames,1);assert.equal(result.min,0);assert.equal(result.max,255);assert.deepEqual(f.signals,[]);
});
test('frame count violation kills verifier and rejects',async()=>{
  const f=fixture();const promise=f.scan('owned.mov',1,'ffmpeg');f.child.stdout.emit('data',Buffer.alloc(1920*1080+1));
  try{assert.equal((await observe(promise)).error,'alpha decoded frame count');assert.equal(f.signals[0],'SIGKILL');}
  finally{f.child.emit('close',null);await promise.catch(()=>{});}
});
test('ffprobe timeout and abort use a non-cooperative kill signal',async()=>{
  let options;
  const verify=vm.runInNewContext('('+declaration('verify')+')',{
    fs:{stat:async()=>({isFile:()=>true,size:1})},MAX_OUTPUT:100,
    execFile:async(a,b,o)=>{options=o;throw Error('test stop before decoding');},Error,
  });
  await assert.rejects(verify('owned.mov',{duration:1}),/test stop/);
  assert.equal(options.timeout,30000);assert.equal(options.killSignal,'SIGKILL');
});

test('real owned process ignoring SIGTERM exits on parent abort',{timeout:5000},async()=>{
  let child;
  const scan=vm.runInNewContext('('+declaration('scanAlpha')+')',{
    cp:{spawn:()=>child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']})},
    Error,alphaExtrema:()=>({min:0,max:255}),setTimeout,clearTimeout,
  });
  const controller=new AbortController();
  const promise=scan('unused.mov',1,'unused',controller.signal);
  const outcome=promise.catch(e=>e.message);
  try {
    await once(child.stdout,'data');
    const closed=once(child,'close');
    controller.abort(Error('owned job cancelled'));
    assert.equal(await outcome,'owned job cancelled');
    await closed;
    assert.ok(child.exitCode!==null||child.signalCode!==null);
  } finally { if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await outcome; }
});
