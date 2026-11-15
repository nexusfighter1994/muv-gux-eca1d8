'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = (() => { try { return require('../node/home-ocr.cjs'); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return {}; throw e; } })();

test('closed native OCR callback list excludes arbitrary work and embedding', () => {
  assert.equal(typeof mod.isOcrCallback, 'function');
  const source = '()=>k({images:de.map(Me=>({id:Me.id,data_base64:pD(Me.localCandidatePath)})),recognize:!0,maxSide:1600,jobId:s??null,purpose:"picture candidates"})';
  assert.equal(mod.isOcrCallback(source), true);
  assert.equal(mod.isOcrCallback(source + ';otherWork()'), false);
  assert.equal(mod.isOcrCallback('()=>embedAndRank({shots:[]})'), false);
});

test('OCR result validation preserves IDs and rejects missing/failed/nonfinite output', () => {
  assert.equal(typeof mod.validateResult, 'function');
  const body = {images:[{id:'a'}]}, row={id:'a',width:640,height:360,boxes:[],text_area_ratio:0,error:null};
  assert.equal(mod.validateResult({results:[row],model:'rapidocr'},body).results[0],row);
  for(const result of [{results:[]},{results:[{...row,error:'timeout'}]}, {results:[{...row,id:'b'}]}, {results:[{...row,text_area_ratio:NaN}]}, {results:[{...row,boxes:[{text:'x',score:NaN}]}]}]) {
    assert.throws(()=>mod.validateResult(result,body));
  }
});

test('adapter offloads only admitted OCR; failure uses existing counted recovery once', async () => {
  assert.equal(typeof mod.install, 'function');
  let original=0,recovery=0,scope=null,homeCalls=0;
  const source='()=>k({images:de.map(Me=>({id:Me.id,data_base64:pD(Me.localCandidatePath)})),recognize:!0,maxSide:1600,jobId:s??null,purpose:"picture candidates"})';
  const client={request:async()=>{original++;return {native:true};}};
  const queue={getScope:s=>s,runCallback:async(s,fn)=>{recovery++;s.recovering=true;try{return await fn();}finally{s.recovering=false;}},drain(){}};
  const callbacks=[];
  const handle=mod.install({queue,client,getScope:()=>scope,isRecovery:()=>!!scope?.recovering,isAborted:()=>false,
    getState:()=>({waiters:[]}),enabled:()=>true,send:async()=>{homeCalls++;throw Error('offline');},probe:async()=>({ready:true,contract:mod.CONTRACT}),schedule:fn=>{callbacks.push(fn);return {unref(){}};}});
  await client.request('/ocr',{method:'POST',body:{images:[{id:'x',data_base64:'YQ=='}]}});
  assert.equal(homeCalls,0);
  scope={nonce:'n',jobId:'j',candidate:true};
  const fn=()=>client.request('/ocr',{method:'POST',body:{images:[{id:'x',data_base64:'YQ=='}]}}); fn.toString=()=>source;
  assert.deepEqual(await queue.runCallback(scope,fn),{native:true});
  assert.equal(homeCalls,1);assert.equal(recovery,1);assert.equal(original,2);
  assert.equal(handle.stats.active,0);assert.equal(handle.stats.fallback,1);
});

test('cancellation never enters native recovery and unknown callbacks never execute on Home', async () => {
  assert.equal(typeof mod.install, 'function');
  let recovery=0,scope={nonce:'n',jobId:'j',signal:AbortSignal.abort(Error('cancel'))};
  const queue={getScope:s=>s,runCallback:async()=>{recovery++;},drain(){}};
  const h=mod.install({queue,client:{request:async()=>{}},getScope:()=>scope,isRecovery:()=>false,isAborted:()=>false,getState:()=>({waiters:[]}),enabled:()=>true,send:async()=>{},probe:async()=>({ready:true,contract:mod.CONTRACT}),schedule:()=>({unref(){}})});
  const fn=()=>{};fn.toString=()=>mod.CALLBACKS[0];
  await assert.rejects(queue.runCallback(scope,fn),/cancel/);assert.equal(recovery,0);
  scope={nonce:'m',jobId:'k'};await queue.runCallback(scope,()=>123);assert.equal(recovery,1);assert.equal(h.stats.completed,0);
});

test('only healthy OCR enables bounded legacy candidates; embed and native recovery untouched', async () => {
  assert.equal(typeof mod.install, 'function');
  const waiters=[{homeKind:'siglip-server',resourceKey:'siglip'},{homeKind:'siglip-home',resourceKey:'siglip'},{homeKind:'siglip-native-recovery',resourceKey:'siglip'},{homeKind:'siglip-server',resourceKey:'ffmpeg'}];
  let ready=false,drains=0;
  const h=mod.install({queue:{runCallback(){},getScope:s=>s,drain(){drains++;}},client:{request(){}},getScope:()=>null,isRecovery:()=>false,isAborted:()=>false,getState:()=>({waiters}),enabled:()=>true,send:async()=>{},probe:async()=>({ready,contract:mod.CONTRACT}),schedule:()=>({unref(){}})});
  await h.probe();h.tick();assert.equal(waiters[0].homeKind,'siglip-server');
  ready=true;await h.probe();h.tick();assert.deepEqual(waiters.map(w=>w.homeKind),['siglip-home-candidate','siglip-home','siglip-native-recovery','siglip-server']);assert.ok(drains>0);
  assert.equal(typeof h.disable,'function');h.disable();h.tick();assert.equal(waiters[0].homeKind,'siglip-server');assert.equal(h.snapshot().ready,false);
});
