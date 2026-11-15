'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {install}=require('../node/home-health-channel.cjs');
function fixture(){
  const calls=[],agents=[];const original={dispatch:(opts,handler)=>{calls.push({native:true,opts,handler});return true;}};let current=original,present=true;
  class Agent{constructor(options){this.options=options;agents.push(this);}dispatch(opts,handler){calls.push({socket:this.options.connect.socketPath,opts,handler});return true;}close(){this.closed=true;}}
  const h=install({getGlobalDispatcher:()=>current,setGlobalDispatcher:v=>current=v,Agent,existsSync:()=>present,env:{}});
  return {h,original,calls,agents,get:()=>current,remove:()=>present=false,set:v=>current=v};
}

test('Motion and map health share the isolated FFmpeg control channel, not their media routes',()=>{
  const f=fixture(),base={origin:'http://10.0.3.1:18191',method:'GET',headers:['authorization','Bearer test']};
  for(const path of ['/motion/health','/map/health']){
    const opts={...base,path};f.get().dispatch(opts,{});assert.match(f.calls.at(-1).socket,/ffmpeg.sock$/);assert.equal(f.calls.at(-1).opts,opts);
  }
  for(const change of [{path:'/motion/render',method:'POST'},{path:'/map/render',method:'POST'},{path:'/motion/health?x=1'},{path:'/map/health',headers:[]},{path:'/motion/health',origin:'http://10.0.3.1:18194'}]){
    f.get().dispatch({...base,...change},{});assert.equal(f.calls.at(-1).native,true);
  }
  assert.equal(f.h.stats.routed,2);f.h.restore();
});

test('hot upgrade keeps the existing health dispatcher and counters for original probes',()=>{
  const native=[],routed=[],legacy={version:1,stats:{routed:123}},original={__vfHomeHealthChannel:legacy,dispatch:(opts,h)=>{native.push({opts,h});return true;}};
  let current=original;
  class Agent{dispatch(opts,h){routed.push({opts,h});return true;}close(){}}
  const deps={Agent,getGlobalDispatcher:()=>current,setGlobalDispatcher:v=>current=v,existsSync:()=>true,env:{}};
  const h=install(deps);assert.notEqual(h,legacy);assert.equal(h.version,2);
  const opts={origin:'http://10.0.3.1:18191',path:'/health',method:'GET',headers:['authorization','Bearer test']},handler={};
  current.dispatch(opts,handler);assert.equal(native.length,1);assert.equal(native[0].opts,opts);assert.equal(legacy.stats.routed,123);
  current.dispatch({...opts,path:'/motion/health'},handler);assert.equal(routed.length,1);assert.equal(h.stats.routed,1);
  assert.equal(install(deps),h);h.restore();assert.equal(current,original);assert.equal(legacy.stats.routed,123);
});
test('only exact authenticated health GET uses isolated channel, payload and handler unchanged',()=>{
  const f=fixture(),handler={};const opts={origin:'http://10.0.3.1:18194',path:'/health',method:'GET',headers:['authorization','Bearer test']};
  f.get().dispatch(opts,handler);assert.match(f.calls[0].socket,/siglip.sock$/);assert.equal(f.calls[0].opts,opts);assert.equal(f.calls[0].handler,handler);
  f.get().dispatch({...opts,origin:'http://10.0.3.1:18191'},handler);assert.match(f.calls[1].socket,/ffmpeg.sock$/);
  assert.equal(f.h.stats.routed,2);f.h.restore();
});
test('all render/rank/config/foreign traffic retains original dispatcher',()=>{
  const f=fixture();for(const change of [{path:'/rank',method:'POST'},{path:'/config',method:'PUT'},{path:'/health?x=1'},{origin:'http://other:18194'},{method:'POST'},{headers:[]}])
    f.get().dispatch({origin:'http://10.0.3.1:18194',path:'/health',method:'GET',headers:['authorization','Bearer test'],...change},{});
  assert.equal(f.calls.length,6);assert.ok(f.calls.every(x=>x.native));assert.equal(f.h.stats.routed,0);f.h.restore();
});
test('absent socket uses original path; rollback does not close native or replace a newer owner',()=>{
  const f=fixture();f.remove();f.get().dispatch({origin:'http://10.0.3.1:18194',path:'/health',method:'GET',headers:['authorization','Bearer test']},{});
  assert.ok(f.calls[0].native);const newer={dispatch(){}};f.set(newer);f.h.restore();assert.equal(f.get(),newer);assert.ok(f.agents.every(a=>a.closed));
});
