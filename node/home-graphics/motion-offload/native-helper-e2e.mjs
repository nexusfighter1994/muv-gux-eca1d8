import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {once} from 'node:events';import {fileURLToPath} from 'node:url';import {createMotionHook} from './hook.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),config=JSON.parse(await fs.readFile(path.join(here,'runtime.json'))),token=crypto.randomBytes(16).toString('hex');
const server=spawn('python',['-B',path.join(here,'test-server.py'),process.execPath,path.join(here,'worker.mjs'),path.join(here,'runtime.json')],{env:{...process.env,MOTION_TEST_TOKEN:token,MOTION_TEST_CONTRACT:config.contract},windowsHide:true,stdio:['ignore','pipe','inherit']});
const started=Date.now();let receipt={state:'running',serverPid:server.pid,synthetic:false};
try{
 const [line]=await once(server.stdout,'data');const port=Number(line.toString().trim());receipt.port=port;await fs.writeFile(path.join(here,'native-helper-receipt.json'),JSON.stringify(receipt));
 const output=path.join(here,'native-helper-output.mp4');let fallback=0;
 const observedFetch=async(...args)=>{const response=await fetch(...args);if(!response.ok)receipt.diagnostic=await response.clone().text();return response;};
 const hook=createMotionHook(async()=>{fallback++;throw Error('native helper failed; no synthetic fallback');},{endpoint:'http://127.0.0.1:'+port,token,contract:config.contract,permitted:()=>true,timeoutMs:220000,ffprobe:config.ffprobe,ffmpeg:config.ffmpeg,fetchImpl:observedFetch});
 const html=await fs.readFile(path.join(here,'../motion-native/project/index.html'),'utf8');
 const marker='<style>[data-vf-unspoken]',split=html.indexOf(marker),end=html.lastIndexOf('</body>');
 if(split<0||end<split)throw Error('native fixture boundary changed');
 const compositionHtml=html.slice(0,split)+html.slice(end),renderOnlyHtml=html.slice(split,end);
 receipt.fixtureSha256=crypto.createHash('sha256').update(html).digest('hex');receipt.renderOnlySeparated=true;
 const result=await hook({compositionHtml,renderOnlyHtml,assets:[{filename:'hero.png',localPath:path.join(here,'../motion-native/project/media/hero.png')}],fps:24,resolution:'1920x1080',workers:1,quality:'standard',workDir:here,targetPath:output,timeoutMs:180000},{duration:3.29});
 receipt={...receipt,passed:true,result,fallback,elapsedMs:Date.now()-started};
}catch(error){receipt={...receipt,passed:false,error:String(error),elapsedMs:Date.now()-started};process.exitCode=1;}
finally{if(server.exitCode===null&&server.signalCode===null){server.kill();await once(server,'close');}receipt.state='finished';receipt.serverClosed=true;await fs.writeFile(path.join(here,'native-helper-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}
