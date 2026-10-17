'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
let api={};try{api=require('../node/final-hash.cjs')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('full SHA256 uses bounded 1-MiB reads with the same digest and fewer callbacks',async()=>{
 assert.equal(typeof api.createFinalHasher,'function');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vf-hash-test-')),file=path.join(root,'test.mp4');
 const bytes=crypto.randomBytes(8*1024*1024+27);fs.writeFileSync(file,bytes);
 let reads=0,syncReads=0,size;const io={...fs,readSync(...a){syncReads++;return fs.readSync(...a)},createReadStream(p,o){size=o?.highWaterMark;const s=fs.createReadStream(p,o);s.on('data',()=>reads++);return s}};
 try{const hash=api.createFinalHasher(()=>{throw Error('old not expected')},{fs:io});assert.equal(await hash(file),crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(size,1048576);assert(reads<=9);assert(syncReads>0,'must not queue every block behind the shared libuv pool');assert.equal(api.createFinalHasher(hash),hash);await assert.rejects(hash(path.join(root,'missing.mp4')),e=>e.code==='ENOENT')}
 finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('promotes only the exact active native final-file hash stream without changing position',()=>{
 assert.equal(typeof api.promoteFinalHashStream,'function');
 const file='/data/projects/example/example.mp4';const listener=i=>t.update(i);
 const fsKey=Symbol('kFs');const make=()=>({[fsKey]:fs,path:file,constructor:{name:'ReadStream'},destroyed:false,readableFlowing:true,bytesRead:123456,_readableState:{highWaterMark:65536},listeners:n=>n==='data'?[listener]:[]});
 const s=make();assert.equal(api.promoteFinalHashStream(s,file),true);assert.equal(s._readableState.highWaterMark,1048576);assert.equal(s.bytesRead,123456);assert.equal(api.promoteFinalHashStream(s,file),false);
 for(const alter of [s=>s.path+='other',s=>s.destroyed=true,s=>s.readableFlowing=false,s=>s.listeners=()=>[()=>{}],s=>s._readableState.highWaterMark=1024]){const other=make();alter(other);assert.equal(api.promoteFinalHashStream(other,file),false)}
 assert.equal(api.promoteFinalHashStream(make(),'/data/projects/example/chunks/example.mp4'),false);
});
test('cooperative reader is per-stream, asynchronous and retains native error/short-read semantics',async()=>{
 assert.equal(typeof api.createCooperativeReadFs,'function');
 const original={read(){throw Error('shared pool must not run')},readSync(fd,b,o,n,p){assert.equal(n,1048576);return 17}};
 const adapter=api.createCooperativeReadFs(original),buffer=Buffer.alloc(1048576);let returned=false;
 const p=new Promise((resolve,reject)=>adapter.read(7,buffer,0,1048576,9,(e,n,b)=>{try{assert(returned);assert.equal(e,null);assert.equal(n,17);assert.equal(b,buffer);resolve()}catch(e){reject(e)}}));returned=true;await p;assert.notEqual(adapter,original);
 const error=Object.assign(Error('disk'),{code:'EIO'});const broken=api.createCooperativeReadFs({readSync(){throw error}});
 await new Promise(resolve=>broken.read(7,buffer,0,1024,0,e=>{assert.equal(e,error);resolve()}));
});
test('promoting an in-flight native read preserves every original byte exactly once',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vf-active-hash-')),file=path.join(root,'test.mp4'),bytes=crypto.randomBytes(12*1024*1024+19);fs.writeFileSync(file,bytes);
 const s=fs.createReadStream(file,{highWaterMark:65536}),t=crypto.createHash('sha256');s.on('data',i=>t.update(i));
 s.prependOnceListener('data',()=>{s.path='/data/projects/example/example.mp4';assert.equal(api.promoteFinalHashStream(s,s.path),true)});
 try{await new Promise((resolve,reject)=>{s.once('end',resolve);s.once('error',reject)});assert.equal(s.bytesRead,bytes.length);assert.equal(t.digest('hex'),crypto.createHash('sha256').update(bytes).digest('hex'))}
 finally{s.destroy();await new Promise(r=>s.closed?r():s.once('close',r));fs.rmSync(root,{recursive:true,force:true})}
});
test('reader yields by a 16-ms time budget, not once per tiny batch under load',()=>{
 let at=0;const queues=[],oldMicro=global.queueMicrotask,oldImmediate=global.setImmediate;
 global.queueMicrotask=fn=>queues.push(['micro',fn]);global.setImmediate=fn=>queues.push(['yield',fn]);
 try{const io=api.createCooperativeReadFs({readSync:()=>1},{now:()=>at}),buffer=Buffer.alloc(1);
  for(let i=0;i<6;i++)io.read(1,buffer,0,1,0,()=>{});
  assert(queues.every(([kind])=>kind==='micro'));
  at=16;io.read(1,buffer,0,1,0,()=>{});assert.equal(queues.at(-1)[0],'yield');
  at=999;queues.at(-1)[1]();io.read(1,buffer,0,1,0,()=>{});assert.equal(queues.at(-1)[0],'micro');
 }finally{global.queueMicrotask=oldMicro;global.setImmediate=oldImmediate}
});
test('artifact wrapper changes only canonical final MP4 hashes, not chunk/checkpoint hashing',()=>{
 const token={},receiver={};let calls=0;
 const original=function(file){assert.equal(this,receiver);calls++;return token};
 const wrapped=api.createFinalHasher(original,{onlyFinalFiles:true});
 for(const file of ['/data/projects/example/chunks/chunk_1.mp4','/data/projects/example/voice.wav','/other.mp4'])assert.equal(wrapped.call(receiver,file),token);
 assert.equal(calls,3);
});
test('explicit checkpoint rescue accepts only native chunk MP4 hash streams',()=>{
 const key=Symbol('kFs'),listener=i=>t.update(i),file='/data/projects/example/chunks/chunk_4/segments/segment_1.mp4';
 const make=()=>({[key]:fs,path:file,constructor:{name:'ReadStream'},destroyed:false,readableFlowing:true,bytesRead:65536,_readableState:{highWaterMark:65536},listeners:()=>[listener]});
 assert.equal(api.promoteFinalHashStream(make(),file),false);
 assert.equal(api.promoteFinalHashStream(make(),file,{checkpoint:true}),true);
 for(const other of ['/data/projects/example/../other/chunks/chunk_1.mp4','/etc/passwd','/data/projects/example/chunks/random.mp4']){const s=make();s.path=other;assert.equal(api.promoteFinalHashStream(s,other,{checkpoint:true}),false)}
});
