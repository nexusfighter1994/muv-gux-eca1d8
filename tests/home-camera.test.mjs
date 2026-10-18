import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraRequestAllowed,wrapHomeCamera} from '../node/home-camera.mjs';
const body={source:'source.jpg',target_resolution:'1920x1080',fps:24,duration_frames:72,
  camera_path:{track:{zoom:[1,1.2]}},wait_for_results:false};
test('only exact plain camera requests qualify',()=>{
  assert.equal(cameraRequestAllowed(body),true);
  for(const patch of [{effects:[]},{fps:30},{duration_frames:361},{camera_path:{track:{zoom:[1]},treatment:{id:'x'}}}])
    assert.equal(cameraRequestAllowed({...body,...patch}),false);
});
function setup(result={offloaded:true,verified:true}){
  const scope={nonce:'n',kind:'video-trim',candidate:true},calls=[];
  const wrapped=wrapHomeCamera(async r=>{calls.push(['native',r]);return 'native'}, {
    getContext:()=>({leases:new Map([['ffmpeg',{boosted:scope}]])}),enabled:()=>true,
    makeRequest:()=>body,runCli:async()=>{calls.push(['home']);return result},
    runRecovery:async(s,fn)=>{assert.equal(s,scope);calls.push(['permit']);return fn()},
    runNativeContext:async(s,fn)=>{calls.push(['nativeContext']);return fn()},
    validScope:s=>s===scope,record:()=>{},stats:{attempted:0,gpu:0,fallback:0},
  });return{scope,calls,wrapped};
}
test('verified Home result does not run native or take recovery permit',async()=>{
  const s=setup();assert.deepEqual(await s.wrapped({targetPath:'/x.mp4'}),{targetPath:'/x.mp4',treatmentStatus:null});
  assert.equal(s.scope.candidate,false);assert.deepEqual(s.calls,[['home']]);
});
test('offline and unverified output recover once with original request',async()=>{
  for(const result of [{offloaded:false},{offloaded:true,verified:false}]){
    const s=setup(result),r={targetPath:'/original.mp4'};assert.equal(await s.wrapped(r),'native');
    assert.deepEqual(s.calls.map(x=>x[0]),['home','permit','nativeContext','native']);assert.equal(s.calls.at(-1)[1],r);
  }
});
test('existing remote checkpoint is resumed, never duplicated on Home',async()=>{
  const s=setup(),r={checkpoint:{remoteTask:{jobId:'already-running'}}};
  assert.equal(await s.wrapped(r),'native');assert.deepEqual(s.calls.map(x=>x[0]),['permit','nativeContext','native']);
});
test('picture treatments stay native',async()=>{
  const s=setup();await s.wrapped({treatmentPlan:{id:'tr_loupe'}});
  assert.deepEqual(s.calls.map(x=>x[0]),['permit','nativeContext','native']);
});
