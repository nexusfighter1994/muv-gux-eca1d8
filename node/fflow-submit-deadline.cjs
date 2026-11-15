'use strict';
const SUBMIT_MS=120000;

function install(client){
  if(client?.__vfFflowSubmitDeadline)return client.__vfFflowSubmitDeadline;
  if(typeof client?.request!=='function'||typeof client.endpointSource!=='function')throw Error('Native FFlow client required');
  const original=client.request;
  const stats={started:0,active:0,completed:0,failed:0,longestMs:0};
  const wrapped=async function(path,options={}){
    if(path!=='/v1/render'||String(options.method||'GET').toUpperCase()!=='POST'
        ||options.body?.wait_for_results!==false||options.timeoutMs!==undefined
        ||client.endpointSource()!=='loopback')return original.apply(this,arguments);
    options.signal?.throwIfAborted();
    const started=Date.now();stats.started++;stats.active++;
    try{
      const value=await original.call(this,path,{...options,timeoutMs:SUBMIT_MS});
      stats.completed++;return value;
    }catch(error){stats.failed++;throw error;}
    finally{stats.active--;stats.longestMs=Math.max(stats.longestMs,Date.now()-started);}
  };
  let restored=false;
  const handle={version:1,timeoutMs:SUBMIT_MS,stats,restore(){
    if(restored)return;
    if(client.request!==wrapped)throw Error('FFlow client owner changed');
    client.request=original;delete client.__vfFflowSubmitDeadline;restored=true;
  }};
  client.request=wrapped;client.__vfFflowSubmitDeadline=handle;
  return handle;
}
module.exports={SUBMIT_MS,install};
