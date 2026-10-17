import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapHomeNormalizeExec} from '../node/home-normalize.mjs';
import * as module from '../node/home-normalize.mjs';

test('native launch prefixes are removed only for the closed CLI recipe',()=>{
  assert.equal(typeof module.nativeNormalizeRequest,'function');
  const argv=['-y','-i','/data/projects/original.mp4','-vf','original-filter'];
  const native=['-y','-hide_banner','-loglevel','error','-threads','1',
    '-filter_threads','1','-filter_complex_threads','1',...argv];
  assert.deepEqual(module.nativeNormalizeRequest({command:['/ffmpeg',...native],timeoutMs:180000}),
    {argv,options:{timeoutMs:180000}});
  assert.deepEqual(module.nativeNormalizeRequest({command:['/ffmpeg','-y','-hide_banner','-loglevel','error',...argv],timeoutMs:180000}),
    {argv,options:{timeoutMs:180000}});
  assert.equal(module.nativeNormalizeRequest({command:['/ffmpeg','-y','-hide_banner','-loglevel','debug',...argv],timeoutMs:180000}),null);
});

function fixture(result){
  const calls=[];let scope={jobId:'job',nonce:'nonce',kind:'video-normalize'};
  const fn=wrapHomeNormalizeExec(async(...args)=>{calls.push({native:args});return {stdout:'native'}},{
    getContext:()=>({leases:new Map([['ffmpeg',{boosted:scope}]])}),getBinary:()=>'/ffmpeg',
    runCli:async(args)=>{calls.push({remote:args});if(result instanceof Error)throw result;return result;},
    runRecovery:async(s,fn)=>{calls.push({reserved:s});return fn();}});
  return {fn,calls,setScope:s=>scope=s};
}

test('only an explicitly scoped native normalization is sent to the Home worker',async()=>{
  const f=fixture({offloaded:true});
  const args=['-i','/data/projects/source.mp4','-r','24','output.mp4'];
  await f.fn('/ffmpeg',args,{timeoutMs:180000});
  assert.deepEqual(f.calls,[{remote:{command:['/ffmpeg',...args],timeoutMs:180000}}]);
  f.setScope({kind:'composition'});await f.fn('/ffmpeg',args);
  assert.ok(f.calls.at(-1).native);
  f.setScope({kind:'video-normalize'});await f.fn('/ffprobe',['-version']);
  assert.equal(f.calls.at(-1).native[0],'/ffprobe');
});

test('PC loss or unsupported argv obtains a normal recovery reservation before native encoding',async()=>{
  for(const result of [{offloaded:false},new Error('PC disconnected')]){
    const f=fixture(result);await f.fn('/ffmpeg',['original-argv']);
    assert.ok(f.calls[0].remote);assert.ok(f.calls[1].reserved);assert.ok(f.calls[2].native);
    assert.deepEqual(f.calls[2].native[1],['original-argv']);
  }
});

test('explicit cancellation never starts an unrequested native replacement',async()=>{
  const error=Object.assign(new Error('canceled'),{name:'AbortError'}),f=fixture(error);
  await assert.rejects(f.fn('/ffmpeg',[],{}),{name:'AbortError'});
  assert.equal(f.calls.length,1);
});
