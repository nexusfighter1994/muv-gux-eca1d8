'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');

function createPublisher({
 projectsDir=path.join(process.env.DATA_DIR||'/data','projects'),
 mediaDir=process.env.FFLOW_STORAGE_DIR||path.join(process.env.DATA_DIR||'/data','engines','fflow','media'),
 baseUrl=process.env.VIDFORGE_FFLOW_BASE_URL||'http://127.0.0.1:8091',
 enabled=process.env.VIDFORGE_FFLOW_LOCAL_STAGING!=='0'
}={}){
 const base=new URL(baseUrl);
 if(!enabled||base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search)throw Error('Scene preview requires local FFlow staging');
 const projects=fs.realpathSync(projectsDir),media=fs.realpathSync(mediaDir);
 const inputs=path.join(media,'inputs');fs.mkdirSync(inputs,{recursive:true});
 if(fs.realpathSync(inputs)!==inputs)throw Error('Scene preview staging scope');
 return function publish(file,jobId){
  const source=fs.realpathSync(file),relative=path.relative(projects,source).split(path.sep);
  if(relative.length!==5||!/^[a-zA-Z0-9_-]+$/.test(relative[0])||relative[1]!=='home-scene-previews'||relative[2]!==jobId
    ||!/^[-a-f0-9]{36}$/.test(jobId)||!/^[a-f0-9]{32}$/.test(relative[3])||!/^shot_[1-9][0-9]*\.jpg$/.test(relative[4]))throw Error('Scene preview source scope');
  const stat=fs.statSync(source);
  if(!stat.isFile()||stat.size<4||stat.size>512*1024)throw Error('Scene preview size');
  const head=Buffer.alloc(3),fd=fs.openSync(source,'r');
  try{fs.readSync(fd,head,0,3,0);}finally{fs.closeSync(fd);}
  if(head[0]!==255||head[1]!==216||head[2]!==255)throw Error('Scene preview JPEG');
  const name='vf-home-scene-'+crypto.createHash('sha256').update(source).digest('hex')+'.jpg',target=path.join(inputs,name);
  try{fs.linkSync(source,target);}catch(error){
   if(error.code!=='EEXIST')throw error;
   const existing=fs.lstatSync(target);
   if(!existing.isFile()||existing.dev!==stat.dev||existing.ino!==stat.ino||existing.size!==stat.size)throw Error('Scene preview staging conflict');
  }
  return base.origin+'/v1/download/inputs/'+name;
 };
}

function installHot(renderer,deps,publisherFactory=createPublisher){
 if(globalThis.__vfDurableScenePreview)throw Error('Scene preview fix already installed');
 if(typeof renderer!=='function'||typeof deps?.setRender!=='function'||typeof deps?.getContext!=='function')throw Error('Scene preview dependencies');
 let publish;
 const wrapped=async function(request){
  const scope=deps.getContext()?.leases?.get('ffmpeg')?.boosted;
  if(scope?.kind!=='video-trim')return renderer.call(this,request);
  try{publish??=publisherFactory();}
  catch{return renderer.call(this,{...request,publishFile:()=>{throw Error('Durable scene preview unavailable')}});}
  return renderer.call(this,{...request,publishFile:file=>publish(file,scope.jobId)});
 };
 deps.setRender(wrapped);
 globalThis.__vfDurableScenePreview={version:1,at:new Date().toISOString(),original:renderer,wrapped};
 return {version:1,at:globalThis.__vfDurableScenePreview.at};
}
module.exports={createPublisher,installHot};
