import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { runRenderChild } from '../map-runtime/render-child-supervisor.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const MAX=32*1024*1024;
export async function execute(p,config){
  if(p.version!==1||!/^[a-f0-9]{32}$/.test(p.id)||p.contract!==config.contract
    ||!Number.isInteger(p.timeoutMs)||p.timeoutMs<1||p.timeoutMs>600000
    ||p.params?.fps!==24||p.params.width!==1920||p.params.height!==1080
    ||!Number.isInteger(p.params.frames)||p.params.frames<30||p.params.frames>360
    ||!['modern','paper'].includes(p.look)||!Array.isArray(p.assets)||p.assets.length>2)throw Error('Map contract');
  for(const [file,expected]of Object.entries(config.files??{}))if(hash(await fs.readFile(file))!==expected)throw Error('Map runtime changed');
  const root=await fs.mkdtemp(path.join(process.env.VF_MOTION_JOB_ROOT??os.tmpdir(),'vfmap-'));
  try{
    const assets=new Map();let total=0;
    for(const a of p.assets){
      if(!/^[a-zA-Z0-9_-]+\.png$/.test(a.filename)||assets.has(a.filename))throw Error('Map asset name');
      const bytes=Buffer.from(a.data,'base64');total+=bytes.length;
      if(total>MAX||hash(bytes)!==a.sha256)throw Error('Map asset hash/size');
      const file=path.join(root,a.filename);await fs.writeFile(file,bytes);assets.set(a.filename,file);
    }
    const params=structuredClone(p.params);
    for(const marker of params.markers??[])if(marker.image_path){if(!assets.has(marker.image_path))throw Error('Missing map pin');marker.image_path=assets.get(marker.image_path);}
    const result=await runRenderChild({options:{params,look:p.look,language:p.language,outputPath:path.join(root,'result.mp4')},timeoutMs:p.timeoutMs});
    if(!result.cleanupConfirmed)throw Error('Map cleanup unconfirmed');
    const bytes=await fs.readFile(result.outputPath);if(bytes.length>MAX||hash(bytes)!==result.sha256)throw Error('Map output hash/size');
    return {version:1,id:p.id,contract:p.contract,backend:'Vulkan GPU',sha256:result.sha256,data:bytes.toString('base64'),probe:result.probe,cleanupConfirmed:true};
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
if(process.argv[2]){try{let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>48*1024*1024)throw Error('Map body limit');}
  const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));process.stdout.write(JSON.stringify(await execute(JSON.parse(raw),config)));
}catch(error){process.stderr.write(error.message);process.exitCode=1;}}
