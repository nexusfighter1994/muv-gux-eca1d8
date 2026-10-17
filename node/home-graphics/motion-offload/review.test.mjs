import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {fileURLToPath} from 'node:url';import {createMotionHook} from './hook.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
test('fallback consumes only remaining original outer budget',async()=>{
 const original=Date.now;let elapsed=0,calls=0,advance=550000;
 Date.now=()=>original()+elapsed;
 try{
  const hook=createMotionHook(async options=>{calls++;assert(options.timeoutMs<=50000&&options.timeoutMs>49000);return 'native';},{endpoint:'http://10.0.3.1:18191',token:'test',contract:'test',permitted:()=>true,fetchImpl:async(url,init)=>{if(init?.method==='POST'){elapsed+=advance;throw Error('network drop');}return Response.json(init?.method==='DELETE'?{terminated:true}:{});}});
  const options={assets:[],compositionHtml:'original',targetPath:path.join(here,'unused'),timeoutMs:600000};
  assert.equal(await hook(options,{duration:1}),'native');assert.equal(calls,1);
  elapsed=0;advance=600001;await assert.rejects(hook(options,{duration:1}),/outer budget exhausted/);assert.equal(calls,1);
 }finally{Date.now=original;}
});
test('bridge allowlist, mid-render cancel, lost response, and missing cleanup ACK',{timeout:20000},async()=>{
 const dir=await fs.mkdtemp(path.join(here,'edge-run-')),fixture=path.join(dir,'fixture.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=1920x1080:r=24','-t','1','-c:v','libx264','-threads','2','-pix_fmt','yuv420p',fixture],{timeout:10000,windowsHide:true});
 const server=spawn('python',['-B',path.join(here,'test-server.py'),process.execPath,path.join(here,'synthetic.mjs'),fixture],{env:{...process.env,MOTION_TEST_TOKEN:'edge-test-token'},windowsHide:true,stdio:['ignore','pipe','ignore']});
 try{
  const [line]=await once(server.stdout,'data'),port=Number(line.toString()),base={endpoint:'http://127.0.0.1:'+port,token:'edge-test-token',contract:'transport-test',permitted:()=>true,requiredBackend:'synthetic-transport-only',timeoutMs:10000};
  let fallback=0;const native=async o=>{fallback++;assert(o.timeoutMs<=10000);return 'native';};
  assert.doesNotThrow(()=>createMotionHook(native,{...base,endpoint:'http://10.0.3.1:18191'}));assert.throws(()=>createMotionHook(native,{...base,endpoint:'http://10.0.3.2:18191'}));assert.throws(()=>createMotionHook(native,{...base,endpoint:'http://10.0.3.1:80'}));
  const options={compositionHtml:'<!doctype html>DELAY',renderOnlyHtml:'',assets:[{filename:'hero.png',localPath:path.join(here,'../motion-native/project/media/hero.png')}],fps:24,resolution:'1920x1080',workers:1,quality:'standard',workDir:dir,targetPath:path.join(dir,'result.mp4'),timeoutMs:10000};
  const abort=new AbortController(),pending=createMotionHook(native,base)(options,{signal:abort.signal,duration:1});
  const rejection=assert.rejects(pending,/mid-cancel/);
  for(let i=0;i<100;i++){try{await fs.stat(fixture+'.active');break;}catch{await new Promise(r=>setTimeout(r,20));}}
  await fs.stat(fixture+'.active');abort.abort(Error('mid-cancel'));await rejection;assert.equal(fallback,0);
  await fs.rm(fixture+'.active');
  const midDrop=async(url,init)=>{
   if(init?.method!=='POST')return fetch(url,init);
   const cut=new AbortController(),pending=fetch(url,{...init,signal:cut.signal}).then(r=>r,e=>e);
   for(let i=0;i<100;i++){try{await fs.stat(fixture+'.active');break;}catch{await new Promise(r=>setTimeout(r,20));}}
   await fs.stat(fixture+'.active');cut.abort(Error('connection lost during render'));const result=await pending;if(result instanceof Error)throw result;return result;
  };
  assert.equal(await createMotionHook(native,{...base,fetchImpl:midDrop})(options,{duration:1}),'native');assert.equal(fallback,1);
  options.compositionHtml='<!doctype html>normal';
  const dropped=async(url,init)=>{const response=await fetch(url,init);if(init?.method==='POST'){await response.arrayBuffer();throw Error('response dropped');}return response;};
  assert.equal(await createMotionHook(native,{...base,fetchImpl:dropped})(options,{duration:1}),'native');assert.equal(fallback,2);
  const noAck=async(url,init)=>init?.method==='DELETE'?new Response('{}',{status:503}):dropped(url,init);
  assert.equal(await createMotionHook(native,{...base,fetchImpl:noAck})(options,{duration:1}),'native');assert.equal(fallback,3);
  let admissions=0;
  assert.equal(await createMotionHook(native,{...base,fetchImpl:async()=>{admissions++;throw Error('must stay quarantined');}})(options,{duration:1}),'native');assert.equal(admissions,0);assert.equal(fallback,4);
  await assert.rejects(fs.stat(options.targetPath),/ENOENT/);
  await fs.writeFile(path.join(here,'review-receipt.json'),JSON.stringify({bridgeAllowlist:true,midRenderCancelNoFallback:true,midRenderNetworkDropCleanupFallback:true,responseDropConfirmedCleanupFallback:true,noAckTrustedLeaseFallback:true,noFurtherHomeAdmissions:true,noLatePublication:true}));
 }finally{if(server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'close');}}
});
test('unconfirmed cleanup never retries cancelled or superseded native scope',async()=>{
 for(const mode of ['cancel','supersede']){
  let current=true,native=0;const abort=new AbortController();
  const hook=createMotionHook(async()=>{native++;},{endpoint:'http://127.0.0.1:2',token:'test',contract:mode,permitted:()=>current,fetchImpl:async(url,init)=>{
   if(init?.method==='POST')throw Error('PC powered off');
   if(init?.method==='DELETE'){if(mode==='cancel')abort.abort(Error('native cancelled'));else current=false;throw Error('PC remains off');}
   return Response.json({});
  }});
  await assert.rejects(hook({assets:[],compositionHtml:'original',targetPath:path.join(here,'unused'),timeoutMs:10000},{signal:abort.signal,duration:1}),mode==='cancel'?/native cancelled/:/scope superseded/);
  assert.equal(native,0);
  if(mode==='supersede')await assert.rejects(hook({assets:[],targetPath:path.join(here,'unused')},{duration:1}),/scope superseded/);
 }
});
