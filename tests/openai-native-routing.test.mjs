import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const adapter=require('../node/openai-images.cjs');
const text=fs.readFileSync(process.env.VF_TEST_BUNDLE||'/app/server/dist/index.mjs','utf8');
const contracts=JSON.parse(fs.readFileSync(new URL('../native-contracts.json',import.meta.url),'utf8'));
function amended(name){
 const original=contracts[name].source;
 if(name==='kFn')return text.slice(text.indexOf('async function kFn('),text.indexOf('async function _Cs('));
 if(name==='ECs')return text.slice(text.indexOf('async function ECs('),text.indexOf('async function ECs(')+text.slice(text.indexOf('async function ECs(')).indexOf('\n}')+2);
 return original;
}
function context(routes){
 const calls=[];let active=0;
 const ctx={console,Error,Object,Array,Set,Map,RegExp,
  Mo:()=>false,DFn:()=>routes,pt:()=>({apiKey:'test'}),vCs:' SUFFIX',nc:e=>e.canceled===true,
  Oe:{run:async(job,lane,fn)=>{calls.push(['lease',job,lane]);active++;try{return await fn();}finally{active--;}}},
  xk:{generate:async args=>{calls.push(['image',args]);return {imagePath:args.destPath};}},
  PFn:async args=>{calls.push(['cli',args]);return false;},yYe:async()=>({cropped:true}),
  ju:()=>false,Nm:{mkdirSync(){}},mR:path,Tr:async()=>{},SFn:async(cache,key,fn)=>fn(),
  fCs:async()=>'',ACs:async()=>'',MFn:async()=>'',Vte:{real:{uploadFile:async()=>''}}};
 vm.createContext(ctx);vm.runInContext(amended('kFn')+'\n'+amended('ECs'),ctx);
 return {ctx,calls,active:()=>active};
}
const direct={id:adapter.ID,provider:adapter.ID,model:adapter.MODEL,credential:{apiKey:'test'}};
test('native thumbnail generation tries CLI then direct with one image lease',async()=>{
 const {ctx,calls,active}=context([{provider:'cli-proxy',model:'gpt-image-2'},direct]);
 const result=await ctx.kFn({prompt:'Test',refImageLocalPath:'reference.png',targetPath:'result.jpg',jobId:'job',kieAvailable:false,referenceUploads:{}});
 assert.equal(result.provider,adapter.ID);assert.equal(active(),0);
 assert.deepEqual(calls.map(x=>x[0]),['lease','cli','image']);
 const args=calls.at(-1)[1];assert.equal(args.outputFormat,'jpeg');assert.equal(args.maxPromptRewrites,0);
 assert.equal(args.referenceImagePaths[0],'reference.png');assert.equal(args.routesOverride[0],direct);
});
test('native thumbnail correction follows the same saved routes with its original reference',async()=>{
 const {ctx,calls}=context([direct]);
 await ctx.ECs({prompt:'Correct',refImageLocalPath:'original.jpg',targetPath:'edited.jpg',jobId:'job'});
 assert.equal(calls.filter(c=>c[0]==='lease').length,1);
 assert.equal(calls.at(-1)[1].usageMeta.operation,'thumbnail-edit');
 assert.equal(calls.at(-1)[1].referenceImagePaths[0],'original.jpg');
});
test('native thumbnail definite failure proceeds, ambiguous result never proceeds',async()=>{
 const {ctx,calls}=context([direct,{provider:'openlux',model:adapter.MODEL}]);
 ctx.xk.generate=async args=>{calls.push(['image',args]);if(args.routesOverride[0].provider===adapter.ID)throw Error('definite');};
 const result=await ctx.kFn({prompt:'T',targetPath:'x.png',referenceUploads:{}});
 assert.equal(result.provider,'openlux');
 ctx.xk.generate=async()=>{throw Object.assign(Error('uncertain'),{noFallback:true});};
 await assert.rejects(ctx.kFn({prompt:'T',targetPath:'x.png',referenceUploads:{}}),/uncertain/);
});
test('native correction dependency override remains intact',async()=>{
 const {ctx,calls}=context([direct]);
 assert.equal(await ctx.ECs({deps:{editImage:async()=>42}}),42);assert.equal(calls.length,0);
});
test('image-only registration uses native encrypted credentials and cheap model validation',()=>{
 const start=text.indexOf('/* vf-custom:openai-images-v1 */');
 const setup=text.slice(start,text.indexOf('\n})();',start)+7).replace(/import __vfOpenAIImagesModule[^;]+;/,'');
 const ctx={__vfOpenAIImagesModule:adapter,__vfCustom:{modEnabled:()=>true,report:()=>{}},
  fki:['openai'],fL:{images:['cliProxy','openlux'],refedits:['cliProxy','openlux'],thumbnails:['cliProxy']},
  ZSi:{images:[],refedits:[],thumbnails:[]},Xw:{},X3r:{},mC:{},anr:{},cnr:{},
  dd:c=>!!c.apiKey,tp:key=>({Authorization:'Bearer '+key}),pd:()=>({status:'verified'}),Jo:()=>({status:'warning'}),
  pt:()=>({apiKey:'fixture'}),gS:(_,rows)=>rows,mu:()=>({}),FQ:()=>({}),lb:()=>({}),
  bcs:async()=>{},Tr:async()=>{},Or:()=>{},Ot:()=>{},tE:()=>[],DFn:()=>[],j3r:()=>null,S1n:()=>null};
 vm.createContext(ctx);vm.runInContext(setup,ctx);
 assert.deepEqual(Array.from(ctx.fki),['openai','openaiImages']);
 for(const lane of ['images','refedits','thumbnails'])assert.equal(ctx.fL[lane][1],adapter.ID);
 const check=ctx.cnr.openaiImages;
 assert.equal(check.request({apiKey:'test'}).url,'https://api.openai.com/v1/models/gpt-image-2');
 assert.equal(check.inspect({id:adapter.MODEL}).status,'verified');
 assert.match(ctx.j3r('images','openaiImages',{model:'wrong'}),/must be gpt-image-2/);
 assert.equal(ctx.j3r('images','openaiImages',{model:adapter.MODEL}),null);
 assert.equal(ctx.S1n(direct),adapter.MODEL);
 ctx.__vfCustom.modEnabled=()=>false;
 assert.equal(ctx.pt('openaiImages',{pipelineId:'thumbnails'}),null);
 assert.equal(ctx.pt('openai').apiKey,'fixture');
});
