'use strict';
const {randomUUID}=require('node:crypto');
const {HEALTH_MS}=require('./home-load-timeouts.cjs');
const FRESH_MS=5000;
const stats={healthReused:0,healthRequests:0,healthCoalesced:0};

function nativeSnapshot(){
  const snapshot=globalThis.__vfHomeSiglipHealth?.snapshot?.();
  return snapshot?{...snapshot,url:(process.env.VF_PC_BOOST_SIGLIP_URL||'http://10.0.3.1:18194').replace(/\/$/,'')}:null;
}

// Only the already-authenticated same worker probe may replace a redundant GET.
// Model, revision, concurrency and transfer checks remain in the original sender.
function createHealthFetch({url,fetcher=fetch,readSnapshot=nativeSnapshot,now=Date.now}){
  const pending=new Map();
  return async function(input,options={}){
    options.signal?.throwIfAborted();
    if(String(input)===url+'/health'&&String(options.method||'GET').toUpperCase()==='GET'){
      let snapshot;
      try{snapshot=readSnapshot();}catch{}
      const age=now()-snapshot?.checkedAt;
      if(snapshot?.url===url&&snapshot.health?.ready===true&&snapshot.checkedAt>0&&age>=0&&age<FRESH_MS){
        stats.healthReused++;
        return Response.json(snapshot.health);
      }
      const key=new Headers(options.headers).get('authorization')||'';
      let probe=pending.get(key);
      if(!probe){
        stats.healthRequests++;
        probe=(async()=>{
          const response=await fetcher(input,{...options,signal:AbortSignal.timeout(HEALTH_MS)});
          let size=0;const chunks=[];
          try{
            for await(const chunk of response.body){size+=chunk.length;if(size>16384)throw Error('Health response too large');chunks.push(Buffer.from(chunk));}
            return {body:Buffer.concat(chunks),status:response.status,headers:response.headers};
          }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
        })();
        pending.set(key,probe);probe.finally(()=>{if(pending.get(key)===probe)pending.delete(key);}).catch(()=>{});
      }else stats.healthCoalesced++;
      const result=await new Promise((resolve,reject)=>{
        const aborted=()=>reject(options.signal.reason);
        options.signal?.addEventListener('abort',aborted,{once:true});
        probe.then(resolve,reject).finally(()=>options.signal?.removeEventListener('abort',aborted));
        if(options.signal?.aborted)aborted();
      });
      return new Response(result.body,{status:result.status,headers:result.headers});
    }
    return fetcher(input,options);
  };
}

// New submissions get a distinct cache namespace; old in-flight work/polls keep
// their original owner, and OCR/native recovery never enter this wrapper.
function installClient({client,createClient,getScope,isRecovery,rankHome,version=100}){
  if(!Number.isSafeInteger(version)||version<100)throw Error('Invalid transport version');
  const marker='__vfFastSiglip'+version,prefix='vfpc-home-fast'+version+'-';
  if(client[marker])return client[marker];
  const original=client.request,sharedStats=client.__vfHomeSiglipTransport?.stats;
  if(typeof original!=='function'||!sharedStats)throw Error('Existing transport required');
  const facade={request:original,__vfNativeSiglipRequest:client.__vfNativeSiglipRequest};
  createClient({client:facade,getScope,isRecovery,rankHome,stats:sharedStats,newId:()=> 'fast'+version+'-'+randomUUID()});
  const wrapped=function(path,options={}){
    if(String(path).startsWith('/embed/'+prefix)||
      path==='/embed'&&String(options.method||'').toUpperCase()==='POST'&&getScope()&&!isRecovery())
      return facade.request.call(this,path,options);
    return original.call(this,path,options);
  };
  const handle={version:1,stats:sharedStats,health:stats,
    restore(){if(client.request!==wrapped)throw Error('Transport changed since installation');client.request=original;delete client[marker];}};
  client.request=wrapped;client[marker]=handle;
  return handle;
}

module.exports={FRESH_MS,stats,createHealthFetch,installClient};
