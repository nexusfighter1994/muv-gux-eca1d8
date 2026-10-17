import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {patchPristine,patchCustom,installMotionOffload} from './server-integration.mjs';
import {verify} from './worker.mjs';
import {fileURLToPath} from 'node:url';

test('actual build29 anchors and post-ModControls initialization',()=>{
 const stock=fs.readFileSync(new URL('../../vf-update-20261015/stock-new.mjs',import.meta.url),'utf8');
 assert(patchPristine(stock).includes('./vf-custom/motion-offload/binding.mjs'));
 const custom=fs.readFileSync(new URL('../context29/node/custom.mjs',import.meta.url),'utf8'),patched=patchCustom(custom);
 const start=patched.indexOf('export function installCustom('),end=patched.indexOf('  if (modEnabled',start),events=[];
 const prefix=patched.slice(start,end).replace('export ','')+'\n}';
 const install=vm.runInNewContext('('+prefix+')',{installModControls:()=>events.push('mods'),__vfInstallMotionOffload:({modEnabled})=>{assert.equal(modEnabled('homeMotion'),true);events.push('motion');},modEnabled:()=>true});
 install({});assert.deepEqual(events,['mods','motion']);assert.throws(()=>patchCustom(patched));assert.throws(()=>patchPristine('drift'));
});

test('real runtime paths, real mod key, pinned contract, safe unavailable defaults',()=>{
 const contract='a'.repeat(64);let config,enabled=true,pc=true,token='local-test-token-only';
 const options={modEnabled:key=>{assert.equal(key,'homeMotion');return enabled;},env:{},configure:value=>{config=value;},readFile:file=>{
  if(file instanceof URL)return JSON.stringify({contract});
  if(file==='/data/runtime/pc-boost.json')return JSON.stringify({enabled:pc});
  assert.equal(file,'/data/runtime/pc-boost-token');if(token===null)throw Error('missing');return token;
 }};
 assert.equal(installMotionOffload(options).installed,true);assert.equal(config.endpoint,'http://10.0.3.1:18191');assert.equal(config.contract,contract);assert.equal(config.getSettings().homeMotion,true);
 enabled=false;assert.equal(config.getSettings().homeMotion,false);enabled=true;pc=false;assert.equal(config.getSettings().homeMotion,false);pc=true;token=null;assert.equal(config.getSettings().homeMotion,false);assert.equal(config.getToken(),'');
 assert.equal(installMotionOffload({...options,env:{VF_PC_BOOST_FFMPEG_URL:'http://10.0.3.2:18191'}}).installed,false);assert.equal(config,null);
});

test('retained real native artifact satisfies strict mixed-codec contract without rerender',async()=>{
 const config=JSON.parse(fs.readFileSync(new URL('./runtime.json',import.meta.url)));
 const probe=await verify(fileURLToPath(new URL('./native-helper-output.mp4',import.meta.url)),{duration:3.29},config.ffprobe,config.ffmpeg);
 assert.equal(probe.profile,'High');assert.equal(probe.time_base,'1/12288');assert.equal(Number(probe.nb_read_frames),79);
});
