'use strict';
const http = require('node:http');
const fs = require('node:fs');
const CONTRACT = 'vf-home-ocr-native-v1-20261029';
const CALLBACKS = [
  '()=>k.runSeparate("siglip ocr",_fs(),()=>Rt({images:Ne.map(ht=>({id:`shot_${ht.shot_id}`,image_url:DWe(ht.thumbnail_url)})),recognize:!0,maxSide:480,signal:I,jobId:i,purpose:"shot thumbnails"}))',
  '()=>(s.ocr||Lxe)({images:fc.map(ro=>({id:`shot_${ro.shot_id}`,image_url:DWe(ro.thumbnail_url)})),recognize:!0,maxSide:480,jobId:i,purpose:"library thumbnails"})',
  '()=>k({images:de.map(Me=>({id:Me.id,data_base64:pD(Me.localCandidatePath)})),recognize:!0,maxSide:1600,jobId:s??null,purpose:"picture candidates"})',
  '()=>d({images:u.map((h,m)=>({id:`frame_${m}`,data_base64:h.dataUrl})),recognize:!0,maxSide:1600,jobId:o.jobId??null,purpose:"final clip"})',
];
const isOcrCallback = fn => CALLBACKS.includes(String(fn));
const fallback = reason => Object.assign(Error('Home OCR requires native recovery: '+reason), {code:'VF_HOME_SIGLIP_FALLBACK'});

function validateResult(value, body) {
  const ids = new Set(body.images.map(i=>i.id));
  if(value?.model!=='rapidocr'||!Array.isArray(value.results)||value.results.length!==ids.size)throw fallback('incomplete result');
  for(const row of value.results) {
    if(!ids.delete(row.id)||row.error||!Number.isSafeInteger(row.width)||row.width<1||!Number.isSafeInteger(row.height)||row.height<1
      ||!Number.isFinite(row.text_area_ratio)||row.text_area_ratio<0||row.text_area_ratio>1||!Array.isArray(row.boxes))throw fallback('invalid image result');
    for(const box of row.boxes)if(typeof box.text!=='string'||!Number.isFinite(box.score)||box.score<0||box.score>1
      ||!['x','y','w','h'].every(k=>Number.isSafeInteger(box[k])&&box[k]>=0)
      ||box.x>row.width||box.y>row.height||box.w>row.width||box.h>row.height)throw fallback('invalid text box');
  }
  return value;
}

function socketRequest(path, body, signal, token, socketPath='/data/runtime/home-ocr.sock', timeoutMs=360000) {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const headers={Authorization:'Bearer '+token,'X-VF-Deadline-Ms':String(timeoutMs)};
    if(payload!==null){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(payload);}
    const req=http.request({socketPath,path,method:payload===null?'GET':'POST',headers,signal},res=>{
      let bytes=0;const chunks=[];
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024){req.destroy(Error('OCR response limit'));return;}chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{try{if(res.statusCode!==200)throw Error('OCR HTTP '+res.statusCode);resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(e){reject(e);}});
    });
    req.on('error',reject);req.end(payload);
  });
}

function createSender({budget,fflow,readToken,fetcher=fetch,request=socketRequest}) {
  const prepare=require('./image-preparer.cjs').createImagePreparer();
  return async(body,scope,options={})=>{
    if(!Array.isArray(body?.images)||body.images.length<1||body.images.length>24)throw fallback('invalid request');
    const timeout=Math.max(1,Math.min(360000,Number(options.timeoutMs)||180000));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('Home OCR deadline')),timeout);
    const signal=scope.signal?AbortSignal.any([scope.signal,controller.signal]):controller.signal;
    const deadline=Date.now()+timeout;let ticket,total=0;
    try {
      ticket=budget.open();
      const trusted=fflow?.baseUrl?new URL(fflow.baseUrl()):null;
      const images=await prepare({candidates:body.images,signal,readLimit:()=>2,fetchImage:async(item,imageSignal)=>{
        let data=item.data_base64;
        if(data){
          if(typeof data!=='string'||data.length>28*1024*1024)throw fallback('image limit');
          const raw=data.replace(/^data:[^,]*;base64,/, '');
          if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw))throw fallback('invalid base64');
          const size=Buffer.byteLength(raw,'base64');ticket.addBytes(size);total+=size;
        } else {
          const target=new URL(item.image_url);
          if(!['http:','https:'].includes(target.protocol))throw fallback('image URL');
          const headers={'User-Agent':'vidforge-siglip-engine/1.0'};
          if(trusted&&target.origin===trusted.origin&&target.pathname.startsWith('/v1/download/'))Object.assign(headers,fflow.authHeaders?.());
          const response=await fetcher(target,{headers,redirect:'error',signal:AbortSignal.any([imageSignal,AbortSignal.timeout(15000)])});
          const chunks=[];let size=0;
          try {
            if(!response.ok)throw Error('image HTTP '+response.status);
            for await(const chunk of response.body){
              imageSignal.throwIfAborted();size+=chunk.length;total+=chunk.length;
              if(size>20*1024*1024||total>45*1024*1024)throw fallback('image limit');
              ticket.addBytes(chunk.length);chunks.push(chunk);
            }
            data=Buffer.concat(chunks).toString('base64');
          }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
        }
        if(total>45*1024*1024)throw fallback('request limit');
        return {id:item.id,data_base64:data};
      }});
      signal.throwIfAborted();
      return validateResult(await request('/ocr',{images,recognize:body.recognize??true,max_side:body.max_side??960},signal,readToken(),undefined,Math.max(1,deadline-Date.now())),body);
    }finally{clearTimeout(timer);controller.abort();ticket?.close();}
  };
}

function install({queue,client,getScope,isRecovery,isAborted,getState,enabled,send,probe,schedule=(fn,ms)=>setInterval(fn,ms),now=Date.now}) {
  if(queue.__vfHomeOcr)return queue.__vfHomeOcr;
  const active=new Set(),stats={active:0,completed:0,images:0,fallback:0,unknownNative:0,lastReason:null,lastCompleted:null};
  const originalCallback=queue.runCallback,originalRequest=client.request;
  let healthyAt=0,probing=false,health=null,paused=false;
  const isEnabled=()=>!paused&&enabled();
  const handle={stats,contract:CONTRACT,async probe(){
    if(probing)return;probing=true;
    try{const h=await probe();if(h.ready!==true||h.contract!==CONTRACT)throw Error('OCR contract');health=h;healthyAt=now();}
    catch{healthyAt=0;}finally{probing=false;}
  },tick(){
    const ready=isEnabled()&&healthyAt>0&&now()-healthyAt<10000;
    for(const w of getState().waiters){
      if(ready&&w.resourceKey==='siglip'&&w.homeKind==='siglip-server'){w.homeKind='siglip-home-candidate';w.__vfOcrCandidate=true;}
      else if(!ready&&w.__vfOcrCandidate&&w.homeKind==='siglip-home-candidate'){w.homeKind='siglip-server';delete w.__vfOcrCandidate;}
    }
    if(ready)queue.drain();
  },disable(){paused=true;handle.tick();clearInterval(handle.timer);clearInterval(handle.healthTimer);},
  snapshot(){return {...stats,ready:isEnabled()&&healthyAt>0&&now()-healthyAt<10000,capacity:2,health,checkedAt:healthyAt,
    queued:getState().waiters.filter(w=>w.__vfOcrCandidate).length};}};
  require('./home-ocr-readiness.cjs').install({handle,queue,getState,enabled:isEnabled,probe,contract:CONTRACT,now});
  queue.runCallback=async function(scope,callback){
    if(!isOcrCallback(callback)){if(scope?.candidate)stats.unknownNative++;return originalCallback.call(this,scope,callback);}
    scope=queue.getScope(scope);if(!scope)throw Error('Expired Home OCR scope');
    scope.signal?.throwIfAborted();
    if(!isEnabled())return originalCallback.call(this,scope,callback);
    const controller=new AbortController();
    scope.signal=scope.signal?AbortSignal.any([scope.signal,controller.signal]):controller.signal;
    const poll=setInterval(()=>{if(isAborted(scope.jobId))controller.abort(Error('OCR job aborted'));},250);poll.unref?.();
    active.add(scope.nonce);stats.active++;
    let recover=false;
    try{return await callback();}
    catch(error){scope.signal.throwIfAborted();if(error?.code!=='VF_HOME_SIGLIP_FALLBACK')throw error;recover=true;}
    finally{clearInterval(poll);active.delete(scope.nonce);stats.active--;}
    if(recover)return originalCallback.call(this,scope,callback);
  };
  client.request=async function(path,options={}){
    const scope=getScope();
    if(isRecovery()||!scope||!active.has(scope.nonce))return originalRequest.call(this,path,options);
    if(path!=='/ocr'||String(options.method).toUpperCase()!=='POST')throw fallback('unsupported endpoint');
    try{
      const value=validateResult(await send(options.body,scope,options),options.body);
      stats.completed++;stats.images+=value.results.length;
      stats.lastCompleted={at:new Date().toISOString(),jobId:scope.jobId,images:value.results.length,backend:'home-cpu'};
      console.info('[home-ocr] completed (Home PC)',JSON.stringify(stats.lastCompleted));
      return value;
    }catch(error){
      scope.signal?.throwIfAborted();stats.fallback++;stats.lastReason=error?.code==='VF_HOME_SIGLIP_FALLBACK'?error.message.slice(0,180):String(error?.name||'OCR unavailable');
      throw error?.code==='VF_HOME_SIGLIP_FALLBACK'?error:fallback(stats.lastReason);
    }
  };
  queue.__vfHomeOcr=handle;
  handle.timer=schedule(()=>handle.tick(),500);handle.timer?.unref?.();
  handle.healthTimer=schedule(()=>void handle.probe(),3000);handle.healthTimer?.unref?.();void handle.probe();
  return handle;
}

function start({scheduler,client,fflow,queue=globalThis.__vfHomeSiglipQueue}) {
  if(globalThis.__vfHomeOcr)return globalThis.__vfHomeOcr;
  const readToken=()=>fs.readFileSync(process.env.VF_PC_BOOST_TOKEN_FILE||'/data/runtime/pc-boost-token','utf8').trim();
  const enabled=()=>{try{const c=JSON.parse(fs.readFileSync(process.env.VF_PC_BOOST_CONFIG||'/data/runtime/pc-boost.json','utf8'));return c.enabled===true&&c.siglipEnabled===true;}catch{return false;}};
  const handle=install({queue,client,enabled,getScope:globalThis.__vfHomeSiglipScope,isRecovery:globalThis.__vfHomeSiglipRecovery,
    isAborted:id=>scheduler.isJobAborted(id),getState:()=>globalThis.__vfSchedulerLane('siglip'),
    send:createSender({budget:globalThis.__vfHomeSiglipBuffers,fflow,readToken}),
    probe:()=>socketRequest('/health',undefined,AbortSignal.timeout(120000),readToken())});
  globalThis.__vfHomeOcr=handle;
  const app=globalThis.__vfCustomApp,stack=app?._router?.stack||app?.router?.stack;
  for(const layer of stack||[]){
    if(layer.route?.path!=='/api/pc-boost'||!layer.route.methods.get)continue;
    const entry=layer.route.stack.at(-1),previous=entry.handle;
    if(previous.__vfHomeOcrStatus)continue;
    const wrapped=function(req,res,next){
      const json=res.json;
      res.json=function(body){res.json=json;return json.call(this,{...body,homeOcr:handle.snapshot()});};
      return previous.call(this,req,res,next);
    };
    wrapped.__vfHomeOcrStatus=true;entry.handle=wrapped;
  }
  return handle;
}
module.exports={CONTRACT,CALLBACKS,isOcrCallback,validateResult,socketRequest,createSender,install,start};
