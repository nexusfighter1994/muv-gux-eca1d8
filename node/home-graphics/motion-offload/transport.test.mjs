import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createMotionHook} from './hook.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
test('real loopback transport, verified synthetic output, PC-off/auth fallback, and cancellation',{timeout:30000},async()=>{
  const dir=await fs.mkdtemp(path.join(here,'test-run-'));const fixture=path.join(dir,'fixture.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=1920x1080:r=24','-t','1','-c:v','libx264','-threads','2','-pix_fmt','yuv420p',fixture],{timeout:15000,windowsHide:true});
  const token=crypto.randomBytes(16).toString('hex');
  const server=spawn('python',['-B',path.join(here,'test-server.py'),process.execPath,path.join(here,'synthetic.mjs'),fixture],{env:{...process.env,MOTION_TEST_TOKEN:token},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let port;try{
    const first=await Promise.race([once(server.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(Error('server startup')),5000).unref())]);port=Number(first[0].toString().trim());assert(port>0);
    let native=0;const original={compositionHtml:'<!doctype html><div data-duration="1">ORIGINAL<img src="media/hero.png"></div>',renderOnlyHtml:'<script>/* original word timings */</script>',assets:[{filename:'hero.png',localPath:path.join(here,'../motion-native/project/media/hero.png')}],fps:24,resolution:'1920x1080',workDir:dir,targetPath:path.join(dir,'home.mp4'),workers:1,quality:'standard',timeoutMs:5000};
    const options={endpoint:'http://127.0.0.1:'+port,token,contract:'transport-test',permitted:()=>true,requiredBackend:'synthetic-transport-only',timeoutMs:5000};
    const fallback=async o=>{native++;assert.equal(o.compositionHtml,original.compositionHtml);assert(o.timeoutMs<=original.timeoutMs);return {native:true};};
    const hook=createMotionHook(fallback,options);const result=await hook(original,{duration:1});assert.equal(result.videoPath,original.targetPath);assert.equal(native,0);assert.equal((await fs.stat(result.videoPath)).size,(await fs.stat(fixture)).size);
    const bad=createMotionHook(fallback,{...options,token:'invalid'});assert.deepEqual(await bad(original,{duration:1}),{native:true});assert.equal(native,1);
    const abort=new AbortController();abort.abort(Error('cancelled'));await assert.rejects(hook(original,{duration:1,signal:abort.signal}),/cancelled/);assert.equal(native,1);
    server.kill();await once(server,'close');
    assert.deepEqual(await hook(original,{duration:1}),{native:true});assert.equal(native,2);
    assert.equal(original.renderOnlyHtml,'<script>/* original word timings */</script>');
    await fs.writeFile(path.join(here,'test-receipt.json'),JSON.stringify({loopbackTransport:true,syntheticOutputStrictDecode:true,pcOffFallback:true,authFallback:true,cancelNoFallback:true,nativeGpuRenderRetested:false,serverClosed:true,port},null,2));
  }finally{if(server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'close');}}
});
