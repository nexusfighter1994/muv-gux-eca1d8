import fs from 'node:fs';
import path from 'node:path';
export function installMapOffload({modEnabled,env=process.env}){
  const target='/data/runtime/home-map-config.json';
  const endpoint=new URL(env.VF_PC_BOOST_FFMPEG_URL||'http://10.0.3.1:18191');
  if(endpoint.protocol!=='http:'||!['10.0.3.1','127.0.0.1'].includes(endpoint.hostname)||endpoint.port!=='18191'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw Error('Invalid Home graphics bridge');
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  const temporary=target+'.'+process.pid+'.tmp';
  const config={enabled:modEnabled('homeMap')===true,endpoint:endpoint.origin,
    tokenFile:env.VF_PC_BOOST_TOKEN_FILE||'/data/runtime/pc-boost-token',
    pcConfig:env.VF_PC_BOOST_CONFIG||'/data/runtime/pc-boost.json',
    contract:'vf27-cartograph-vulkan-v1',workDir:'/data/runtime/home-map-artifacts'};
  fs.writeFileSync(temporary,JSON.stringify(config),{mode:0o600});fs.renameSync(temporary,target);
  env.VF_MAP_OFFLOAD_CONFIG=target;
  return {installed:true};
}
