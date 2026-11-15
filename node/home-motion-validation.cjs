'use strict';
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const CONTRACT='vf-native-motion-validation-20261031-v1';
const MAX=32*1024*1024;
const CALLBACKS=[
  'async()=>j3()?{valid:!0,issues:[]}:__vfCustom.validateHomeMotion(t,{compositionHtml:n.html,assets:n.assets,fps:v_e,resolution:fWt},r,cl())',
  '()=>__vfCustom.validateHomeMotion(t,{compositionHtml:o.html,assets:o.assets,fps:v_e,resolution:fWt},n,cl())',
];
const isCallback=fn=>CALLBACKS.includes(String(fn));
function validateResult(value){
  if(typeof value?.valid!=='boolean'||!Array.isArray(value.issues)||value.issues.length>1000
    ||(value.valid&&value.issues.some(i=>i?.severity!=='warning'))||(!value.valid&&!value.issues.length)
    ||(value.warnings!==undefined&&!Array.isArray(value.warnings)))throw Error('Invalid validation verdict');
  if(['infrastructure','mixed'].includes(value.failureType)||value.issues.some(i=>i?.category==='infrastructure'))throw Error('Validator infrastructure failure');
  return value;
}
function supported(p){
  return p&&Object.keys(p).every(k=>['compositionHtml','assets','fps','resolution'].includes(k))
    &&typeof p.compositionHtml==='string'&&Buffer.byteLength(p.compositionHtml)<=2*1024*1024
    &&Array.isArray(p.assets)&&p.assets.length<=32&&p.fps===24&&p.resolution==='1920x1080';
}
async function prepare(p,signal){
  if(!supported(p))throw Error('Unsupported validation input');
  const assets=[],names=new Set();let total=0;
  for(const a of p.assets){
    signal.throwIfAborted();
    if(!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}$/.test(a.filename)||a.filename.includes('..')||names.has(a.filename)
      ||Object.keys(a).some(k=>!['filename','localPath'].includes(k)))throw Error('Unsupported asset');
    names.add(a.filename);
    if(!a.localPath){assets.push({filename:a.filename});continue;}
    const file=await fs.open(a.localPath,'r');
    try{
      const before=await file.stat();
      if(!before.isFile()||before.size+total>MAX)throw Error('Asset size');
      const data=await file.readFile({signal}),after=await file.stat();
      if(data.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Asset changed');
      total+=data.length;assets.push({filename:a.filename,data:data.toString('base64'),sha256:crypto.createHash('sha256').update(data).digest('hex')});
    }finally{await file.close();}
  }
  return {...p,assets,contract:CONTRACT,realAssets:!['0','false','no','off'].includes(String(process.env.VIDFORGE_FRAMESHIFT_VALIDATE_REAL_ASSETS||'').trim().toLowerCase())};
}
function create({queue,send,enabled,getSignal=()=>undefined,isAborted=()=>false,now=Date.now}){
  const stats={active:0,completed:0,rejected:0,fallback:0,last:null};let health=null,healthAt=0;
  const handle={
    setHealth(h){health=h;healthAt=h?.ready===true&&h.contract===CONTRACT&&h.capacity===2?now():0;},
    ready(){return enabled()&&healthAt>0&&now()-healthAt<12000;},
    snapshot(){return {...stats,ready:handle.ready(),capacity:2,health,healthAt};},
    async run(native,p,context={}){
      if(!queue.ownsCurrent())return native();
      const caller=context.signal||getSignal(),controller=new AbortController();
      const signal=caller?AbortSignal.any([caller,controller.signal]):controller.signal;
      const check=()=>{signal.throwIfAborted();if(isAborted(context.jobId))throw Error('Motion job aborted');};
      const watch=setInterval(()=>{if(isAborted(context.jobId))controller.abort(Error('Motion job aborted'));},250);watch.unref?.();
      const timer=setTimeout(()=>controller.abort(Error('Home validation deadline')),360000);timer.unref?.();
      let recover=false;stats.active++;
      try{
        check();if(!enabled()||!supported(p))throw Error('Native validation required');
        const response=validateResult(await send(p,signal));check();
        stats.completed++;if(!response.valid)stats.rejected++;
        stats.last={jobId:context.jobId,at:new Date().toISOString(),valid:response.valid};
        console.info('[home-motion-validation] completed (Home PC)',JSON.stringify(stats.last));
        return response;
      }catch(error){
        caller?.throwIfAborted();if(isAborted(context.jobId))throw error;
        stats.fallback++;healthAt=0;recover=true;
      }finally{clearInterval(watch);clearTimeout(timer);stats.active--;controller.abort();}
      if(recover)return queue.native(()=>{caller?.throwIfAborted();if(isAborted(context.jobId))throw Error('Motion job aborted');return native();});
    },
  };
  return handle;
}
function start({queue,enabled,isAborted}){
  const readToken=()=>require('node:fs').readFileSync(process.env.VF_PC_BOOST_TOKEN_FILE||'/data/runtime/pc-boost-token','utf8').trim();
  const request=require('./home-ocr.cjs').socketRequest;
  const socket='/data/runtime/home-motion-validation.sock';
  const handle=create({queue,enabled,isAborted,send:async(p,signal)=>{
    const body=await prepare(p,signal);
    const response=await request('/validate',body,signal,readToken(),socket,350000);
    if(response?.contract!==CONTRACT)throw Error('Validation contract mismatch');
    return response.result;
  }});
  let probing=false;
  const probe=async()=>{if(probing)return;probing=true;try{handle.setHealth(await request('/health',undefined,AbortSignal.timeout(4000),readToken(),socket));}catch{handle.setHealth(null);}finally{probing=false;}};
  handle.timer=setInterval(probe,4000);handle.timer.unref();void probe();
  globalThis.__vfHomeMotionValidation=handle;
  require('./home-motion-readiness-batch.cjs').install(queue,handle);
  const app=globalThis.__vfCustomApp,stack=app?._router?.stack||app?.router?.stack;
  for(const layer of stack||[]){
    if(layer.route?.path!=='/api/pc-boost'||!layer.route.methods.get)continue;
    const entry=layer.route.stack.at(-1),previous=entry.handle;
    if(previous.__vfMotionValidationStatus)continue;
    const wrapped=function(req,res,next){const json=res.json;res.json=function(body){res.json=json;return json.call(this,{...body,homeMotionValidation:handle.snapshot()});};return previous.call(this,req,res,next);};
    wrapped.__vfMotionValidationStatus=true;entry.handle=wrapped;
  }
  return handle;
}
module.exports={CONTRACT,CALLBACKS,isCallback,validateResult,supported,prepare,create,start};
