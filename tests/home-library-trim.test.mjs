import test from 'node:test';
import assert from 'node:assert/strict';
import * as library from '../node/home-library-trim.mjs';

const callback='()=>Yn({sourceUrl:jr.entry.sourceUrl,localVideoUrl:jr.entry.sourceUrl,videoFps:jr.entry.videoFps,startSec:jr.start_sec,endSec:jr.end_sec,targetPath:AS.join(Wr,`library-${jr.shot_id}.mp4`),deadlineTs:Date.now()+lp})';

test('only the complete original native library trim callback is admitted',()=>{
  assert.equal(library.isHomeLibraryTrimCallback(callback),true);
  for(const value of [callback+';unknown()',callback.replace('Yn(','other('),callback.replace('videoFps:jr.entry.videoFps','videoFps:24'),'()=>unknown()'])
    assert.equal(library.isHomeLibraryTrimCallback(value),false);
});

test('historical library candidates become trim scopes before the existing sampler guard',()=>{
  const scope={kind:'video-normalize',candidate:true,nonce:'n'},order=[];
  let sampler=request=>({run(fn){order.push({kind:scope.kind,candidate:scope.candidate});return fn;},finish(){order.push('finish');}});
  const scheduler={run(...args){return args;}};
  library.installHomeLibraryTrim({scheduler,getSlotMeasurer:()=>sampler,setSlotMeasurer:fn=>sampler=fn,
    getContext:()=>({leases:new Map([['ffmpeg',{boosted:scope}]])})});
  const sample=sampler({resourceKey:'ffmpegHome'});
  assert.equal(sample.run(callback),callback);
  assert.equal(scope.kind,'video-trim');assert.equal(scope.candidate,false);
  assert.deepEqual(order,[{kind:'video-trim',candidate:false}]);
  sample.finish();assert.equal(order.at(-1),'finish');
  const options={signal:{},quality:'1080p'};
  assert.deepEqual(scheduler.run('job','ffmpeg',callback,options)[3],{...options,homeKind:'video-trim',operation:'home-library-trim'});
  assert.equal(scheduler.run('job','ffmpeg',()=>1,options)[3],options);
});

test('unknown candidate keeps its original counted recovery classification',()=>{
  const scope={kind:'video-normalize',candidate:true};
  let sampler=()=>({run:fn=>fn,finish(){}});
  library.installHomeLibraryTrim({scheduler:{run(){}},getSlotMeasurer:()=>sampler,setSlotMeasurer:fn=>sampler=fn,
    getContext:()=>({leases:new Map([['ffmpeg',{boosted:scope}]])})});
  sampler({resourceKey:'ffmpegHome'}).run(()=>1);
  assert.equal(scope.kind,'video-normalize');assert.equal(scope.candidate,true);
});
