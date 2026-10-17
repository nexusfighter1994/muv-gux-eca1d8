import preparerModule from './image-preparer.cjs';
const sharedImagePreparer=preparerModule.createImagePreparer();

export function createHomeSiglipRankSender({getScope,budget,readConfig,readToken,readTransfer,url,fflow,fetcher=fetch,prepareImages=sharedImagePreparer}){
  return async function rankHome(body){
    const scope=getScope(),config=readConfig();
    if(!scope||config.enabled!==true||config.siglipEnabled!==true)return null;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
    const signal=scope.signal?AbortSignal.any([controller.signal,scope.signal]):controller.signal;
    let ticket;
    async function read(response,limit,charged=false,readSignal=signal,onBytes){
      if(!response.ok)throw Error('HTTP '+response.status);
      if(Number(response.headers.get('content-length'))>limit)throw Error('image transfer limit');
      let size=0;const chunks=[];
      for await(const chunk of response.body){
        readSignal.throwIfAborted();size+=chunk.byteLength;
        if(size>limit)throw Error('image transfer limit');
        onBytes?.(chunk.byteLength);
        if(charged)ticket.addBytes(chunk.byteLength);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks,size);
    }
    try{
      ticket=budget.open();
      const token=readToken();if(token.length<16)return null;
      const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
      const health=JSON.parse((await read(await fetcher(url+'/health',{headers,signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])}),16384)).toString());
      const mode=/^(1|true|yes|on)$/i.test(String(process.env.VIDFORGE_SIGLIP_LEGACY_TEXT||''))?'legacy':'siglip2';
      if(health.ready!==true||health.model_id!=='google/siglip2-base-patch16-384'||health.model_revision!=='f775b65a79762255128c981547af89addcfe0f88'
        ||!health.text_modes?.includes(mode)||health.multi_query!==true)return null;
      const transfer=readTransfer(),imageLimit=transfer.siglipMaxImageMb*1024*1024,bodyLimit=Math.max(45,transfer.siglipMaxImageMb)*1024*1024;
      if(!Number.isSafeInteger(health.transferLimits?.siglipMaxImageMb)||health.transferLimits.siglipMaxImageMb<transfer.siglipMaxImageMb)return null;
      if(Number(health.active_tasks||0)>=Math.max(1,Math.min(25,config.siglipConcurrency)))return null;
      const trusted=fflow?.baseUrl?new URL(fflow.baseUrl()):null;
      if(body.candidates.some(candidate=>typeof candidate.image_url!=='string'))return null;
      let total=0;
      const candidates=await prepareImages({candidates:body.candidates,signal,
        readLimit:()=>readConfig().siglipConcurrency,
        fetchImage:async(candidate,imageSignal)=>{
          const target=new URL(candidate.image_url),imageHeaders={'User-Agent':'vidforge-siglip-engine/1.0'};
          if(trusted&&target.origin===trusted.origin&&target.pathname.startsWith('/v1/download/')&&fflow.authHeaders)Object.assign(imageHeaders,fflow.authHeaders());
          const fetchSignal=AbortSignal.any([imageSignal,AbortSignal.timeout(15000)]);
          const response=await fetcher(candidate.image_url,{headers:imageHeaders,redirect:'error',signal:fetchSignal});
          try{
            const type=response.headers.get('content-type');if(type&&!type.toLowerCase().startsWith('image/'))throw Error('image type');
            const bytes=await read(response,imageLimit,true,fetchSignal,n=>{
              total+=n;if(total>bodyLimit)throw Error('request transfer limit');
            });
            return {id:candidate.id,image_base64:bytes.toString('base64'),metadata:candidate.metadata||{}};
          }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
        }});
      const request={query:body.query,candidates,text_mode:mode};
      for(const key of ['queries','negative_queries','negative_weight'])if(body[key]!==undefined)request[key]=body[key];
      scope.pcSubmitted=true;
      const response=await fetcher(url+'/rank',{method:'POST',headers,body:JSON.stringify(request),signal});
      const result=JSON.parse((await read(response,2*1024*1024)).toString()),expected=new Set(body.candidates.map(c=>c.id));
      if(result.status!=='completed'||!Array.isArray(result.results)||result.results.length!==expected.size)throw Error('incomplete GPU ranking');
      for(const row of result.results)if(!expected.delete(row.id)||typeof row.score!=='number'||!Number.isFinite(row.score)||row.error)throw Error('invalid GPU ranking');
      return result;
    }finally{scope.pcSubmitted=false;ticket?.close();clearTimeout(timer);controller.abort();}
  };
}

export function createHomeSiglipClient({client,getScope,isRecovery=()=>false,rankHome,newId=()=>crypto.randomUUID()}){
  if(client.__vfHomeSiglipTransport)return;
  const original=client.request,server=client.__vfNativeSiglipRequest||original;
  const finished=new Map();let retained=0;
  const remove=id=>{const entry=finished.get(id);if(entry){retained-=entry.bytes;finished.delete(id);}};
  const fallback=reason=>Object.assign(Error('Home SigLIP requires native recovery: '+reason),{code:'VF_HOME_SIGLIP_FALLBACK'});
  const stats={completed:0,fallback:0,lastReason:null};
  client.request=async function(path,options={}){
    if(isRecovery())return server.call(this,path,options);
    const id=String(path).startsWith('/embed/')?String(path).slice(7):null;
    if(id&&finished.has(id))return finished.get(id).result;
    const scope=getScope();if(!scope)return original.call(this,path,options);
    if(path!=='/embed'||String(options.method||'').toUpperCase()!=='POST'||!Array.isArray(options.body?.candidates))throw fallback('unsupported native endpoint');
    try{
      const result=await rankHome(options.body);
      if(!result)throw fallback('PC unavailable, busy or incompatible');
      const bytes=Buffer.byteLength(JSON.stringify(result))*4;
      if(bytes>64*1024*1024)throw fallback('result cache budget');
      while(finished.size&&(retained+bytes>64*1024*1024||finished.size>=512))remove(finished.keys().next().value);
      const taskId='vfpc-home-'+newId();finished.set(taskId,{result,bytes});retained+=bytes;
      const timer=setTimeout(()=>remove(taskId),120000);timer.unref?.();stats.completed++;
      return {task_id:taskId,status:'queued'};
    }catch(error){
      if(scope.signal?.aborted)throw scope.signal.reason;
      stats.fallback++;stats.lastReason=String(error?.message||error).slice(0,200);
      throw error?.code==='VF_HOME_SIGLIP_FALLBACK'?error:fallback(stats.lastReason);
    }
  };
  client.__vfHomeSiglipTransport={stats};return client.__vfHomeSiglipTransport;
}
