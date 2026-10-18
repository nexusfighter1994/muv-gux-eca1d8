import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export async function executeCamera(payload,configPath,root){
  if(configPath instanceof URL)configPath=fileURLToPath(configPath);
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  const scene=['native-scenes-cpu-v1','native-scenes-gpu-v1'].includes(payload.operation);
  if(payload.version!==1||!/^[a-f0-9]{32}$/.test(payload.id)||![config.contract,...config.sceneContracts||[]].includes(payload.contract)
    ||(!scene&&payload.operation!=='native-camera-nvenc-v1')||!Number.isInteger(payload.timeoutMs)
    ||payload.timeoutMs<1||payload.timeoutMs>600000)throw Error('Camera envelope');
  for(const [file,expected]of Object.entries(config.files)){
    if(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')!==expected)throw Error('Camera runtime changed');
  }
  return new Promise((resolve,reject)=>{
    const child=spawn(config.python,[path.join(path.dirname(configPath),scene?'scene_worker.py':'camera_worker.py'),configPath,root],
      {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,OPENCV_FFMPEG_CAPTURE_OPTIONS:'threads;4',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
    let size=0,errors='',chunks=[],settled=false;
    const timer=setTimeout(()=>{child.kill();},payload.timeoutMs+90000);
    child.stdout.on('data',b=>{size+=b.length;if(size>48*1024*1024)child.kill();else chunks.push(b);});
    child.stderr.on('data',b=>{if(errors.length<1024)errors+=b.toString();});
    child.stdin.on('error',()=>{});
    child.on('error',error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});
    child.on('close',code=>{
      clearTimeout(timer);if(settled)return;settled=true;
      if(code!==0||size>48*1024*1024)return reject(Error('Camera child failed'));
      try{const result=JSON.parse(Buffer.concat(chunks));
        if(result.operation!==payload.operation||(!scene&&(result.backend!=='NVENC High'
          ||result.gpuPolicy!=='nvenc-high-qp14-v1')))throw Error('Camera receipt');
        resolve(result);
      }catch(error){reject(error);}
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
