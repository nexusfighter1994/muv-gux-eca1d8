import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureMotion} from './binding.mjs';
import {patchBundle} from './install.mjs';

export function patchPristine(source,{bindingModulePath='./vf-custom/motion-offload/binding.mjs'}={}){
  return patchBundle(source,bindingModulePath);
}

export function patchCustom(source,{integrationModulePath='./motion-offload/server-integration.mjs'}={}){
  const anchor='  installModControls({ app, db, requireOwner, runtimePath });';
  if(source.split(anchor).length!==2||source.includes('__vfInstallMotionOffload'))throw Error('custom install boundary changed');
  return 'import {installMotionOffload as __vfInstallMotionOffload} from '+JSON.stringify(integrationModulePath)+';\n'+source.replace(anchor,anchor+'\n  __vfInstallMotionOffload({modEnabled});');
}

export function installMotionOffload({modEnabled,contractFile=new URL('./motion-contract.json',import.meta.url),env=process.env,readFile=fs.readFileSync,configure=configureMotion}={}){
  try{
    const {contract}=JSON.parse(readFile(contractFile,'utf8'));
    if(!/^[a-f0-9]{64}$/.test(contract)||typeof modEnabled!=='function')throw Error('contract');
    const endpoint=new URL(env.VF_PC_BOOST_FFMPEG_URL||'http://10.0.3.1:18191');
    if(endpoint.protocol!=='http:'||!['127.0.0.1','10.0.3.1'].includes(endpoint.hostname)||endpoint.port!=='18191'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw Error('bridge');
    const getToken=()=>{
      try{const token=readFile(env.VF_PC_BOOST_TOKEN_FILE||'/data/runtime/pc-boost-token','utf8').trim();return token.length>=16&&token.length<=4096&&!/[\r\n]/.test(token)?token:'';}catch{return '';}
    };
    const getSettings=()=>{
      try{return {homeMotion:modEnabled('homeMotion')===true&&JSON.parse(readFile(env.VF_PC_BOOST_CONFIG||'/data/runtime/pc-boost.json','utf8')).enabled===true&&Boolean(getToken())};}catch{return {homeMotion:false};}
    };
    // Home may use up to 70% of the render deadline; a server CPU fallback then
    // still gets the FULL original deadline. A dead Home PC fails the 5 s health probe.
    configure({getSettings,getToken,endpoint:endpoint.origin,contract,ffmpeg:'ffmpeg',ffprobe:'ffprobe',
      healthTimeoutMs:5000,nativeReserveRatio:0.3,freshNativeBudget:true});
    return {installed:true,contract,endpoint:endpoint.origin};
  }catch{
    configure(null);
    return {installed:false,reason:'motion_configuration_unavailable'};
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,target]=process.argv.slice(2);
  if(!target||!['patch-pristine','patch-custom'].includes(command))throw Error('Usage: server-integration.mjs patch-pristine|patch-custom BUILD_FILE');
  const source=fs.readFileSync(target,'utf8');
  fs.writeFileSync(target,command==='patch-pristine'?patchPristine(source):patchCustom(source));
}
