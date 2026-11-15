const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createLocalImageFetch}=require('../node/siglip-local-images.cjs');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vf-siglip-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'outputs'));await fs.mkdir(path.join(root,'inputs'));
  const bytes=Buffer.from([255,216,255,0,1,2,3]);
  await fs.writeFile(path.join(root,'outputs','frame.jpg'),bytes);
  let remote=0;
  const fetcher=createLocalImageFetch({mediaDir:root,trusted:'http://127.0.0.1:8091',fetcher:async()=>{remote++;return new Response('remote');}});
  return {root,bytes,fetcher,remote:()=>remote};
}
test('local FFlow image is byte-identical, streamed and does not use HTTP',async t=>{
  const f=await fixture(t),r=await f.fetcher('http://127.0.0.1:8091/v1/download/outputs/frame.jpg');
  assert.equal(r.headers.get('content-type'),'image/jpeg');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()),f.bytes);assert.equal(f.remote(),0);
});
test('foreign origin, unsupported extension, missing image and traversal use original HTTP',async t=>{
  const f=await fixture(t);
  for(const url of ['http://elsewhere/v1/download/outputs/frame.jpg','http://127.0.0.1:8092/v1/download/outputs/frame.jpg',
    'http://127.0.0.1:8091/v1/download/outputs/movie.mp4','http://127.0.0.1:8091/v1/download/outputs/missing.jpg',
    'http://127.0.0.1:8091/v1/download/outputs/%2e%2e/secret.jpg','http://127.0.0.1:8091/v1/download/outputs/a%2fb.jpg',
    'http://user:pass@127.0.0.1:8091/v1/download/outputs/frame.jpg'])assert.equal(await(await f.fetcher(url)).text(),'remote');
  assert.equal(f.remote(),7);
});
test('symlink escape is never read locally',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'secret.jpg'),'secret');
  try{await fs.symlink(path.join(f.root,'secret.jpg'),path.join(f.root,'outputs','escape.jpg'));}
  catch(e){if(e.code==='EPERM'){t.skip('symlinks require Windows privilege; verified in Linux image');return;}throw e;}
  assert.equal(await(await f.fetcher('http://127.0.0.1:8091/v1/download/outputs/escape.jpg')).text(),'remote');
});
test('pre-aborted read preserves cancellation and never falls back',async t=>{
  const f=await fixture(t),c=new AbortController(),reason=Error('cancel');c.abort(reason);
  await assert.rejects(f.fetcher('http://127.0.0.1:8091/v1/download/outputs/frame.jpg',{signal:c.signal}),e=>e===reason);
  assert.equal(f.remote(),0);
});
test('large files are streamed, cancellation closes the stream',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'outputs','large.png'),Buffer.alloc(1024*1024,3));
  const c=new AbortController(),r=await f.fetcher('http://127.0.0.1:8091/v1/download/outputs/large.png',{signal:c.signal});
  const reader=r.body.getReader();assert.ok((await reader.read()).value.length<=65536);
  c.abort();await assert.rejects(reader.read());await reader.cancel().catch(()=>{});
});
