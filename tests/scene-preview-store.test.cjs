const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPublisher,installHot}=require('../node/scene-preview-store.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vf-preview-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const projects=path.join(root,'projects'),media=path.join(root,'media');
 fs.mkdirSync(media,{recursive:true});
 const job='2b8e5fbd-cdb9-4b04-999d-eff35b3058ee';
 const file=path.join(projects,'project-123','home-scene-previews',job,'a'.repeat(32),'shot_1.jpg');
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from([255,216,255,224,1,2,255,217]));
 const options={projectsDir:projects,mediaDir:media,baseUrl:'http://127.0.0.1:8091'};
 return {file,media,job,options};
}
test('durable FFlow link preserves exact bytes and survives publisher recreation',t=>{
 const f=fixture(t),url=createPublisher(f.options)(f.file,f.job);
 assert.match(url,/^http:\/\/127.0.0.1:8091\/v1\/download\/inputs\/vf-home-scene-[a-f0-9]{64}\.jpg$/);
 const target=path.join(f.media,'inputs',path.basename(new URL(url).pathname));
 assert.deepEqual(fs.readFileSync(target),fs.readFileSync(f.file));
 assert.equal(createPublisher(f.options)(f.file,f.job),url);
});
test('rejects another job, traversal and non-preview files',t=>{
 const f=fixture(t),publish=createPublisher(f.options);
 assert.throws(()=>publish(f.file,'1'.repeat(36)),/scope/);
 assert.throws(()=>publish(path.join(f.media,'other.jpg'),f.job));
});
test('refuses remote endpoints and disabled local staging',t=>{
 const f=fixture(t);
 assert.throws(()=>createPublisher({...f.options,baseUrl:'https://example.test'}),/local/);
 assert.throws(()=>createPublisher({...f.options,enabled:false}),/local/);
});
test('refuses malformed and oversized previews',t=>{
 const f=fixture(t),publish=createPublisher(f.options);
 fs.writeFileSync(f.file,'not a jpeg');assert.throws(()=>publish(f.file,f.job),/JPEG/);
 fs.writeFileSync(f.file,Buffer.alloc(512*1024+1));assert.throws(()=>publish(f.file,f.job),/size/);
});
test('detects a conflicting existing target instead of overwriting it',t=>{
 const f=fixture(t),publish=createPublisher(f.options),url=publish(f.file,f.job);
 const target=path.join(f.media,'inputs',path.basename(new URL(url).pathname));
 fs.unlinkSync(target);fs.writeFileSync(target,'wrong');
 assert.throws(()=>publish(f.file,f.job),/conflict/);
 assert.equal(fs.readFileSync(target,'utf8'),'wrong');
});
test('hot wrapper preserves native calls and changes only owned Home preview publishing',async t=>{
 t.after(()=>delete globalThis.__vfDurableScenePreview);
 delete globalThis.__vfDurableScenePreview;
 let active=false,installed;
 const scope={kind:'video-trim',jobId:'job'},request={deadlineTs:123,signal:new AbortController().signal,publishFile:()=>'/dead'};
 const owner={};
 const renderer=async function(r){assert.equal(this,owner);return r;};
 installHot(renderer,{setRender:r=>installed=r,getContext:()=>({leases:new Map(active?[['ffmpeg',{boosted:scope}]]:[])})},()=>((file,job)=>file+'/'+job));
 assert.equal(await installed.call(owner,request),request);
 active=true;const result=await installed.call(owner,request);
 assert.equal(result.deadlineTs,request.deadlineTs);assert.equal(result.signal,request.signal);
 assert.equal(result.publishFile('image'),'image/job');assert.equal(request.publishFile(),'/dead');
 assert.throws(()=>installHot(renderer,{}),/already/);
});
test('unavailable durable staging leaves fallback handling to the original wrapper',async t=>{
 t.after(()=>delete globalThis.__vfDurableScenePreview);delete globalThis.__vfDurableScenePreview;
 let installed;
 installHot(async r=>{assert.throws(()=>r.publishFile('x'),/unavailable/);return 'counted fallback'},
  {setRender:r=>installed=r,getContext:()=>({leases:new Map([['ffmpeg',{boosted:{kind:'video-trim',jobId:'job'}}]])})},()=>{throw Error('disk');});
 assert.equal(await installed({}),'counted fallback');
});
