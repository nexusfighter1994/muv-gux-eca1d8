'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs');
const {createRequire}=require('node:module'),{install}=require('../node/home-health-channel.cjs');
test('real built-in fetch preserves authentication, errors and cancellation over Unix channel',async()=>{
  const undici=createRequire('/app/server/package.json')('undici'),socket='/tmp/vf-health-channel-test-'+process.pid+'.sock';
  let delay=false;const server=http.createServer((req,res)=>{
    if(delay)return;
    res.writeHead(req.headers.authorization==='Bearer test'?200:401,{'content-type':'application/json'});res.end(JSON.stringify({ready:true}));
  });
  await new Promise(r=>server.listen(socket,r));
  class Agent extends undici.Agent{constructor(opts){super({...opts,connect:{socketPath:socket}});}}
  const original=undici.getGlobalDispatcher();
  const handle=install({...undici,Agent,existsSync:()=>true,env:{}});
  try{
    const response=await fetch('http://10.0.3.1:18194/health',{headers:{Authorization:'Bearer test'}});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ready:true});assert.equal(handle.stats.routed,1);
    for(const path of ['/motion/health','/map/health']){
      const graphic=await fetch('http://10.0.3.1:18191'+path,{headers:{Authorization:'Bearer test'}});
      assert.equal(graphic.status,200);assert.deepEqual(await graphic.json(),{ready:true});
    }
    assert.equal(handle.stats.routed,3);
    const bad=await fetch('http://10.0.3.1:18191/health',{headers:{Authorization:'Bearer wrong'}});assert.equal(bad.status,401);await bad.text();
    delay=true;await assert.rejects(fetch('http://10.0.3.1:18194/health',{headers:{Authorization:'Bearer test'},signal:AbortSignal.timeout(100)}),/abort|timeout/i);
  }finally{handle.restore();assert.equal(undici.getGlobalDispatcher(),original);server.closeAllConnections();await new Promise(r=>server.close(r));if(fs.existsSync(socket))fs.unlinkSync(socket);}
});
