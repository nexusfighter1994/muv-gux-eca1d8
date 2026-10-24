'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const fixture=require('./fixtures/native-chunk-20261023.json');
const {createRecovery}=require('../node/home-chunk-recovery.cjs');
for(const release of [false,true])test('actual native chunk/poll releases Home before native admission, slot release='+release,async()=>{
 const scope={jobId:'parent',nonce:'lease',kind:'composition'},trace=[];
 let active=null,attempt=0,gateResolve;
 const gate=new Promise(r=>gateResolve=r);
 const ctx=vm.createContext({kg:()=>release,yO:1,pK:'high',Date,setTimeout,
  h5e:()=>({}),ses:s=>({code:'RENDER_FAILED',message:s.data.error.message}),BAe:Error,
  xsr:async s=>s,D1o:async e=>({finalSegments:e.segments,finalAudioTracks:e.audio_tracks}),O1o:()=>{},tge:()=>{},
  SZi:()=>false,bO:async()=>trace.push('download'),
  Vn:{request:async()=>{trace.push('submit');return {data:{job_id:'remote-'+(++attempt)}};}},
  AO:async()=>attempt===1?{data:{status:'failed',error:{message:'Native Home fallback admission timed out'}}}:
    {data:{status:'completed',result:{download_url:'output.mp4'}}},
  Oe:{run:async(j,l,fn,opts)=>{
   if(opts.homeKind==='native-recovery'){trace.push('native-wait');await gate;}
   active=opts.homeKind==='native-recovery'?null:scope;
   trace.push(active?'home-admit':'native-admit');
   try{return await fn();}finally{active=null;trace.push('release');}
  }}});
 vm.runInContext(Object.values(fixture).join(';'),ctx);
 const recovery=createRecovery({getContext:()=>({leases:new Map([['ffmpeg',{boosted:active}]])}),
  validScope:s=>s===active,isAborted:()=>false,cancel:async()=>assert.fail('terminal worker should not be canceled')});
 ctx.ec=recovery.wrapPoll(ctx.ec);ctx.Oe.run=recovery.wrapRun(ctx.Oe.run);
 const payload={segments:[{type:'video',source:'segment.mp4'}],audio_tracks:[{source:'voice.wav'}]};
 const saved=[];
 const pending=recovery.wrapChunk(ctx.IDa)({jobId:'parent',payload,checkpoint:{saveRemoteTask:x=>saved.push(x)}});
 await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(trace,['home-admit','submit','release','native-wait']);
 gateResolve();await pending;
 assert.equal(attempt,2);assert.equal(recovery.stats.recovered,1);
 assert.equal(saved[1],null);
 assert.deepEqual(trace,['home-admit','submit','release','native-wait','native-admit','submit',...(release?['release','download']:['download','release'])]);
 assert.equal(payload.segments[0].source,'segment.mp4');assert.equal(payload.audio_tracks[0].source,'voice.wav');
});
