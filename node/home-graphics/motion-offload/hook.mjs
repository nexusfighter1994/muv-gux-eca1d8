import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {verify,MAX} from './worker.mjs';
import remoteActive from '../remote-active.cjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
// An unconfirmed remote cancel (Home lost mid-render) pauses Home offers, but only for a while:
// Home's single graphics slot rejects new work while an abandoned job could still run.
export const QUARANTINE_MS=5*60*1000;
const uncertainHome={until:new Map(),
  has(key){const t=this.until.get(key);if(t==null)return false;if(Date.now()>=t){this.until.delete(key);return false;}return true;},
  add(key){this.until.set(key,Date.now()+QUARANTINE_MS);}};
export function createMotionHook(nativeRender,{endpoint,token,contract,permitted,ffprobe,ffmpeg,timeoutMs=600000,fetchImpl=fetch,requiredBackend='d3d11/nvidia',nativeReserveMs=0,nativeReserveRatio=0,healthTimeoutMs=null,remoteResource='frameshift',freshNativeBudget=false}){
  const base=new URL(endpoint);if(base.protocol!=='http:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(['127.0.0.1','localhost','[::1]'].includes(base.hostname)||(base.hostname==='10.0.3.1'&&base.port==='18191')))throw Error('private tunnel required');
  const homeKey=base.origin+'|'+contract;
  return async function(options,{signal,duration}={}){
    if(signal?.aborted)throw signal.reason;
    if(!await permitted?.())throw Error('render scope superseded; no native fallback');
    if(signal?.aborted)throw signal.reason;
    // Server parallelism (1..3 capture workers) maps to the ONE Home graphics slot;
    // frames are identical, the native fallback keeps the original worker count.
    const sourceWorkers=options.workers??1;
    if(!Number.isInteger(sourceWorkers)||sourceWorkers<1||sourceWorkers>3)return nativeRender(options);
    // The Home contract accepts 0 < duration <= 15 s; never upload work it must reject.
    if(!(Number.isFinite(duration)&&duration>0&&duration<=15))return nativeRender(options);
    const id=crypto.randomBytes(16).toString('hex');const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
    const budget=Math.min(timeoutMs,options.timeoutMs??600000),deadline=Date.now()+budget,baseReserve=Math.min(30000,budget/3);
    const fixedReserve=Number.isFinite(nativeReserveMs)&&nativeReserveMs>baseReserve?Math.min(Math.max(0,budget-1),nativeReserveMs):baseReserve;
    // A relative reserve keeps most of the deadline for server CPU recovery when Home is slow or lost.
    const ratioReserve=Number.isFinite(nativeReserveRatio)&&nativeReserveRatio>0&&nativeReserveRatio<1?Math.min(Math.max(0,budget-1),Math.ceil(budget*nativeReserveRatio)):0;
    const reserve=Math.max(fixedReserve,ratioReserve);
    const controller=new AbortController();let timer=setTimeout(()=>controller.abort(Error('motion timeout')),budget-reserve);
    const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});
    const part=options.targetPath+'.motion-'+id+'.part';
    let possibleRemote=false,endRemote=null;
    try{
      if(uncertainHome.has(homeKey))throw Error('Home quarantined pending owned-job cleanup');
      const assets=[];let total=0;for(const a of options.assets??[]){const b=await fs.readFile(a.localPath);total+=b.length;if(total>MAX)throw Error('input size');assets.push({filename:a.filename,sha256:hash(b),data:b.toString('base64')});}
      const healthSignal=Number.isFinite(healthTimeoutMs)&&healthTimeoutMs>0?AbortSignal.any([controller.signal,AbortSignal.timeout(Math.ceil(healthTimeoutMs))]):controller.signal;
      const health=await fetchImpl(new URL('/motion/health',base),{headers,signal:healthSignal});if(!health.ok)throw Error('Home offline');
      const payload={version:1,id,contract,compositionHtml:options.compositionHtml,renderOnlyHtml:options.renderOnlyHtml??'',assets,fps:options.fps,resolution:options.resolution,workers:1,quality:options.quality??'standard',duration,timeoutMs:Math.max(1,Math.floor(deadline-Date.now()-reserve))};
      possibleRemote=true;endRemote=remoteActive.begin(remoteResource);
      const response=await fetchImpl(new URL('/motion/render',base),{method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal});
      if(!response.ok)throw Error('Home unavailable');
      // Home has rendered: receiving and verifying may use the whole budget; the native fallback keeps its own fresh budget.
      if(freshNativeBudget){clearTimeout(timer);timer=setTimeout(()=>controller.abort(Error('motion receive timeout')),Math.max(1,deadline-Date.now()));}
      const reader=response.body.getReader();const chunks=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>48*1024*1024){await reader.cancel();throw Error('response size');}chunks.push(value);}
      const result=JSON.parse(Buffer.concat(chunks).toString());const bytes=Buffer.from(result.data??'','base64');
      if(result.version!==1||result.id!==id||result.contract!==contract||result.backend!==requiredBackend||bytes.length>MAX||hash(bytes)!==result.sha256)throw Error('receipt mismatch');
      if(controller.signal.aborted)throw controller.signal.reason;
      await fs.writeFile(part,bytes,{flag:'wx'});const probe=await verify(part,payload,ffprobe,ffmpeg,controller.signal);
      if(controller.signal.aborted)throw controller.signal.reason;
      if(!await permitted()){const error=Error('render scope superseded');error.noFallback=true;throw error;}
      const artifactsDir=path.join(options.workDir,'artifacts');await fs.mkdir(artifactsDir,{recursive:true});
      await fs.writeFile(path.join(artifactsDir,'home-motion-receipt.json'),JSON.stringify({id,contract,sha256:result.sha256,backend:result.backend,probe}));
      if(controller.signal.aborted)throw controller.signal.reason;
      await fs.rename(part,options.targetPath);return {videoPath:options.targetPath,width:probe.width,height:probe.height,duration:Number(probe.duration),artifactsDir};
    }catch(error){
      controller.abort(error);
      if(possibleRemote){let ack;try{const response=await fetchImpl(new URL('/motion/'+id,base),{method:'DELETE',headers,signal:AbortSignal.timeout(12000)});if(response.ok)ack=await response.json();}catch{}
        if(ack?.terminated!==true)uncertainHome.add(homeKey);}
      // The server render below uses server CPU again: release the extra slot first.
      endRemote?.();
      if(signal?.aborted)throw signal.reason;
      if(error.noFallback)throw error;
      await fs.rm(part,{force:true});
      if(!await permitted?.())throw Error('render scope superseded; no native fallback');
      if(signal?.aborted)throw signal.reason;
      // freshNativeBudget: a lost or slow Home attempt must never shorten the server render.
      const remaining=freshNativeBudget?(options.timeoutMs??budget):deadline-Date.now();if(remaining<=0)throw Error('native outer budget exhausted');
      clearTimeout(timer);
      return await nativeRender({...options,timeoutMs:remaining});
    }finally{endRemote?.();clearTimeout(timer);signal?.removeEventListener('abort',abort);await fs.rm(part,{force:true});}
  };
}
