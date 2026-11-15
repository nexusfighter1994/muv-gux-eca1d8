'use strict';
const fs=require('node:fs');
function authorized(headers){
  if(Array.isArray(headers)){
    for(let i=0;i<headers.length;i+=2)if(String(headers[i]).toLowerCase()==='authorization'&&/^Bearer .+/.test(String(headers[i+1])))return true;
    return false;
  }
  if(typeof headers?.get==='function')return /^Bearer .+/.test(headers.get('authorization')||'');
  return Object.entries(headers||{}).some(([k,v])=>k.toLowerCase()==='authorization'&&/^Bearer .+/.test(String(v)));
}
function install(deps={}){
  const {getGlobalDispatcher,setGlobalDispatcher,Agent}=deps.Agent?deps:require('undici');
  const exists=deps.existsSync||fs.existsSync,env=deps.env||process.env,original=getGlobalDispatcher();
  const legacy=original.__vfHomeHealthChannel;
  if(legacy?.version>=2)return legacy;
  const agents=new Map(),stats={routed:0,missingSocket:0};
  for(const [kind,port,key] of [['ffmpeg',18191,'VF_PC_BOOST_FFMPEG_URL'],['siglip',18194,'VF_PC_BOOST_SIGLIP_URL']]){
    const u=new URL(env[key]||'http://10.0.3.1:'+port);
    if(u.protocol!=='http:'||!['10.0.3.1','127.0.0.1'].includes(u.hostname)||u.port!==String(port)||u.pathname!=='/'||u.search||u.username||u.password)continue;
    const socketPath='/data/runtime/home-health-'+kind+'.sock';
    const paths=new Set(kind==='ffmpeg'?['/health','/motion/health','/map/health']:['/health']);
    if(legacy)paths.delete('/health');
    agents.set(u.origin,{socketPath,paths,agent:new Agent({connections:2,pipelining:1,connect:{socketPath}})});
  }
  const dispatcher={
    dispatch(opts,handler){
      const target=agents.get(String(opts.origin));
      if(target&&opts.method==='GET'&&target.paths.has(opts.path)&&authorized(opts.headers)){
        if(exists(target.socketPath)){stats.routed++;return target.agent.dispatch(opts,handler);}
        stats.missingSocket++;
      }
      return original.dispatch(opts,handler);
    },
    close(...args){return original.close(...args);},
    destroy(...args){return original.destroy(...args);},
  };
  const handle={version:2,stats,restore(){
    if(getGlobalDispatcher()===dispatcher)setGlobalDispatcher(original);
    for(const {agent} of agents.values())Promise.resolve(agent.close()).catch(()=>{});
  }};
  dispatcher.__vfHomeHealthChannel=handle;setGlobalDispatcher(dispatcher);return handle;
}
module.exports={install};
