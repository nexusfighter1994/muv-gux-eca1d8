import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createMotionHook} from './home-graphics/motion-offload/hook.mjs';
import {cameraRequestAllowed} from './home-camera.mjs';
export async function executeCameraRequest(request){
  if(!cameraRequestAllowed(request.render))return {offloaded:false};
  const config=JSON.parse(await fs.readFile('/data/runtime/pc-boost.json','utf8'));
  if(!config.enabled)return {offloaded:false};
  const image=await fs.realpath(request.imagePath),parent=await fs.realpath(path.dirname(request.targetPath));
  if(!image.startsWith('/data/projects/')||!parent.startsWith('/data/projects/'))return {offloaded:false};
  const stat=await fs.stat(image);
  if(!stat.isFile()||stat.size<1||stat.size>16*1024*1024||path.extname(image).toLowerCase()!==path.extname(request.render.source))return {offloaded:false};
  try{await fs.lstat(request.targetPath);return {offloaded:false};}catch(e){if(e.code!=='ENOENT')throw e;}
  const workDir=await fs.mkdtemp(path.join(os.tmpdir(),'vf-home-camera-'));
  const token=(await fs.readFile('/data/runtime/pc-boost-token','utf8')).trim();
  const fetchImpl=(url,options)=>{
    const target=new URL(url);target.pathname=target.pathname.replace(/^\/motion\//,'/map/');
    if(options.method==='POST'){
      const payload=JSON.parse(options.body);
      delete payload.compositionHtml;delete payload.renderOnlyHtml;
      payload.operation='native-camera-nvenc-v1';payload.render=request.render;
      options={...options,body:JSON.stringify(payload)};
    }
    return fetch(target,options);
  };
  try{
    const hook=createMotionHook(async()=>({offloaded:false}),{
      endpoint:'http://10.0.3.1:18191',token,contract:'vf27-cartograph-vulkan-v1',
      permitted:()=>true,ffmpeg:'ffmpeg',ffprobe:'ffprobe',requiredBackend:'NVENC High',
      fetchImpl,healthTimeoutMs:5000,remoteResource:'ffmpeg',freshNativeBudget:true});
    const result=await hook({workers:1,assets:[{filename:request.render.source,localPath:image}],
      targetPath:request.targetPath,workDir,fps:24,resolution:'1920x1080',timeoutMs:600000},
      {duration:request.render.duration_frames/24});
    if(!result.videoPath)return {offloaded:false};
    const receipt=JSON.parse(await fs.readFile(path.join(result.artifactsDir,'home-motion-receipt.json'),'utf8'));
    await fs.writeFile(request.targetPath+'.home-camera.json',JSON.stringify({...receipt,
      operation:'native-camera-nvenc-v1',gpuPolicy:'nvenc-high-qp14-v1',verified:true}),{flag:'wx'});
    return {offloaded:true,verified:true};
  }finally{await fs.rm(workDir,{recursive:true,force:true});}
}
if(process.argv[2]){
  try{console.log(JSON.stringify(await executeCameraRequest(JSON.parse(Buffer.from(process.argv[2],'base64')))));}
  catch{console.log(JSON.stringify({offloaded:false}));}
}
