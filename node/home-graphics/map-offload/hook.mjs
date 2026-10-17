import fs from 'node:fs/promises';
import { createMotionHook } from '../motion-offload/hook.mjs';
export function createMapHook(native,config){
  return async options=>{
    if(options.signal?.aborted)throw options.signal.reason;
    const p=options.params;
    if(p.fps!==24||p.width!==1920||p.height!==1080||p.frames<30||p.frames>360)return native(options);
    const params=structuredClone(p),assets=[];
    for(const [i,marker]of (params.markers??[]).entries())if(marker.image_path){assets.push({filename:`pin-${i}.png`,localPath:marker.image_path});marker.image_path=`pin-${i}.png`;}
    if(assets.length>2)return native(options);
    const fetchImpl=config.fetchImpl??fetch;
    const bridge=async(url,init)=>{
      url=new URL(url);url.pathname=url.pathname.replace(/^\/motion(?=\/)/,'/map');
      if(init?.body){const body=JSON.parse(init.body);body.params=params;body.look=options.look;body.language=options.language;delete body.compositionHtml;delete body.renderOnlyHtml;init={...init,body:JSON.stringify(body)};}
      return fetchImpl(url,init);
    };
    const budget=Math.min(config.timeoutMs??600000,options.timeoutMs??600000);
    // Keep most of the original deadline for CPU recovery; an unavailable PC
    // must not consume the map's entire render allowance before fallback.
    const nativeReserveMs=Math.max(Math.ceil(budget*.6),budget-120000);
    const render=createMotionHook(async opts=>native({...options,timeoutMs:opts.timeoutMs??options.timeoutMs}),
      {...config,fetchImpl:bridge,requiredBackend:'Vulkan GPU',nativeReserveMs,healthTimeoutMs:5000});
    const result=await render({targetPath:options.outputPath,workDir:config.workDir??'.',assets,compositionHtml:'',fps:24,resolution:'1920x1080',workers:1,quality:'standard',timeoutMs:options.timeoutMs},
      {signal:options.signal,duration:p.frames/24});
    return result.outputPath?result:{outputPath:options.outputPath,fileSize:(await fs.stat(options.outputPath)).size};
  };
}
let configured=null;
export function configureMap(config){configured=config;}
export async function renderMapOffload(native,options){
  if(!configured&&process.env.VF_MAP_OFFLOAD_CONFIG){
    const file=process.env.VF_MAP_OFFLOAD_CONFIG;
    try{
      const config=JSON.parse(await fs.readFile(file,'utf8'));
      if(config.enabled){configured={...config,token:await fs.readFile(config.tokenFile,'utf8').then(s=>s.trim()),permitted:async()=>{try{return JSON.parse(await fs.readFile(file,'utf8')).enabled===true&&JSON.parse(await fs.readFile(config.pcConfig,'utf8')).enabled===true;}catch{return false;}}};}
    }catch{return native(options);}
  }
  if(!configured)return native(options);
  return createMapHook(native,configured)(options);
}
export const contractName='vf27-cartograph-vulkan-v1';
