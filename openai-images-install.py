"""Reviewed thin native Images/Settings hooks; no app import or credential material."""
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
MARK = '/* vf-custom:openai-images-v1 */'
UI_MARK = '/* vf-custom:openai-images-ui-v1 */'

def replace_once(text, old, new, label):
    if text.count(old) != 1:
        raise RuntimeError('OpenAI Images fingerprint mismatch: ' + label)
    return text.replace(old, new, 1)

SETUP = r'''
/* vf-custom:openai-images-v1 */
import __vfOpenAIImagesModule from './vf-custom/openai-images.cjs';
;(()=>{
 const id='openaiImages',model='gpt-image-2',enabled=()=>__vfCustom.modEnabled('openaiImages');
 const credentialAccess=pt;
 pt=function(name,...args){return name===id&&!enabled()?null:credentialAccess.call(this,name,...args)};
 Object.assign(pt,credentialAccess);
 if(!fki.includes(id))fki.push(id);
 for(const lane of ['images','refedits','thumbnails']){
  if(!fL[lane].includes(id))fL[lane].splice(fL[lane].indexOf('cliProxy')+1,0,id);
  if(!ZSi[lane].includes(id))ZSi[lane].push(id);
 }
 if(!fL.thumbnails.includes('openlux'))fL.thumbnails.splice(fL.thumbnails.indexOf(id)+1,0,'openlux');
 if(!ZSi.thumbnails.includes('openlux'))ZSi.thumbnails.push('openlux');
 Xw=Object.freeze({...Xw,[id]:Object.freeze({model})});
 X3r=Object.freeze({...X3r,[id]:Object.freeze({model})});
 mC=Object.freeze({...mC,[id]:Object.freeze({model}),openlux:Object.freeze({model})});
 anr={...anr,[id]:'OpenAI Images (direct)'};
 cnr={...cnr,[id]:{
  complete:dd,
  request:c=>({url:'https://api.openai.com/v1/models/gpt-image-2',headers:tp(c.apiKey)}),
  inspect:data=>data?.id===model?pd():Jo('unexpected_response','OpenAI did not confirm gpt-image-2 access.')
 }};
 const dependencies={enabled,getCredential:(name,lane)=>pt(name,{pipelineId:lane}),
  order:(lane,rows)=>gS(lane,rows,mu()),readModel:(lane,name)=>FQ(lb(),lane,name).model,
  openluxEnabled:()=>__vfCustom.modEnabled('thumbnailOpenlux')};
 const render=__vfOpenAIImagesModule.createOpenAIImagesRenderer({request:bcs,download:Tr,recordUsage:Or,emit:Ot});
 globalThis.__vfOpenAIImages={enabled,render,thumbnailRouting:true};
 tE=__vfOpenAIImagesModule.wrapImageRoutes(tE,dependencies);
 DFn=__vfOpenAIImagesModule.wrapThumbnailRoutes(DFn,dependencies);
 const checkModel=j3r;
 j3r=(lane,key,value)=>['images','refedits','thumbnails'].includes(lane)&&key.split('.').some(p=>p.split('#')[0]===id)&&value.model&&value.model!==model
  ?`${key}.model must be ${model}`:checkModel(lane,key,value);
 const transparentModel=S1n;
 S1n=route=>route?.provider===id?model:transparentModel(route);
 __vfCustom.report('openaiImages',true);
})();
'''

THUMBNAIL_BRANCH = r'''
if(f.provider==='openaiImages'||f.provider==='openlux'){
 try{
  await xk.generate({prompt:`${e}${vCs}`,aspectRatio:'16:9',referenceImagePaths:t?[t]:[],destPath:r,jobId:n,variant:'high',
   outputFormat:/\.jpe?g$/i.test(r)?'jpeg':'png',routesOverride:[f],maxPromptRewrites:0,
   usageMeta:{category:'thumbnails',operation:__vfOperation}});
  const crop=await yYe(r);
  a?.({step:'thumbnails',message:`Thumbnail completed on ${f.provider} (${f.model}).`,data:{provider:f.provider,model:f.model,widescreenCrop:crop?.cropped===true}});
  return{targetPath:r,sourceUrl:null,provider:f.provider,model:f.model};
 }catch(error){
  if(error?.noFallback===true||nc(error,{jobId:n,scheduler:Oe}))throw error;
  c.push({provider:f.provider,model:f.model,error});
 }
 continue;
}
'''

EDIT = r'''async function ECs({prompt:e,refImageLocalPath:t,targetPath:r,jobId:n,deps:o,emit:i}){
 if(typeof o?.editImage==='function')return o.editImage({prompt:e,refImageLocalPath:t,targetPath:r,jobId:n});
 return kFn({prompt:e,refImageLocalPath:t,targetPath:r,jobId:n,kieAvailable:!!pt('kieai',{pipelineId:'thumbnails'})?.apiKey,
  referenceUploads:{},emit:i,operation:'thumbnail-edit'});
}'''

TRANSPARENT = r'''async function gLt({prompt:e,model:t=Yw,aspectRatio:r='16:9',variant:n='low',referenceImagePaths:o=[],referenceImageUrls:i=[],destPath:s,jobId:a=null,usageMeta:c={}}){
 const routes=tE(t,{referenceImagePaths:o,referenceImageUrls:i}).map(route=>({...route,model:S1n(route)})).filter(route=>route.model);
 if(!routes.length)throw new ke({code:'not_configured',provider:'image',message:'No configured route supports native transparency',noRetry:true});
 return xk.generate({prompt:ure(e),model:routes[0].model,variant:n,aspectRatio:r,background:'transparent',outputFormat:'png',destPath:s,jobId:a,usageMeta:c,
  referenceImagePaths:o,referenceImageUrls:i,routesOverride:routes,maxPromptRewrites:0});
}'''

def patch_node(text):
    if MARK in text:
        if text.count(MARK) != 1:
            raise RuntimeError('Duplicate OpenAI Images installation')
        return text
    contracts = json.loads((HERE / 'native-contracts.json').read_text())
    for name, contract in contracts.items():
        original = contract['source']
        if hashlib.sha256(original.encode()).hexdigest() != contract['sha256'] or text.count(original) != 1:
            raise RuntimeError('OpenAI Images native contract changed: ' + name)
    original = contracts['i1n']['source']
    amended = replace_once(original, '){let{provider:', '){if(e.provider==="openaiImages")return globalThis.__vfOpenAIImages.render(arguments[0]);let{provider:', 'renderer entry')
    text = replace_once(text, original, amended, 'renderer')
    original = contracts['kFn']['source']
    amended = replace_once(original, 'deps:s,emit:a})', 'deps:s,emit:a,operation:__vfOperation="thumbnail-generate"})', 'thumbnail operation')
    amended = replace_once(amended, 'if(f.provider==="cli-proxy")', THUMBNAIL_BRANCH + 'if(f.provider==="cli-proxy")', 'thumbnail route dispatch')
    amended = replace_once(amended, 'operation:"thumbnail-generate"', 'operation:__vfOperation', 'thumbnail operation pass-through')
    text = replace_once(text, original, amended, 'thumbnail generation')
    text = replace_once(text, contracts['ECs']['source'], EDIT, 'thumbnail editing')
    text = replace_once(text, contracts['gLt']['source'], TRANSPARENT, 'transparent routing')
    text = replace_once(text, '["openlux","surplus","fastgen","kieai","69labs"].includes(z.provider)', '["openlux","surplus","fastgen","kieai","69labs","openaiImages"].includes(z.provider)', 'image route dispatch')
    text = replace_once(text, 'usageMeta:p});U?.model', 'usageMeta:p,variant:n,background:i,outputFormat:s});U?.model', 'image output contract')
    return text + '\n' + SETUP

def patch_ui(text):
    if UI_MARK in text:
        if text.count('id:"openaiImages"') != 3 or text.count('name:"openaiImages"') != 1:
            raise RuntimeError('OpenAI Images UI contract is incomplete')
        return text
    definition = '{name:"openaiImages",label:"OpenAI Images (direct)",role:"text-images",description:"Official OpenAI API for images, reference edits and thumbnails. GPT Image 2 only; billed separately from your ChatGPT plan.",aliases:["openai","direct","images","gpt-image-2","thumbnail"],fields:[Xt()]},'
    text = replace_once(text, '{name:"openlux",label:"OpenLux"', definition + '{name:"openlux",label:"OpenLux"', 'credential UI')
    leg = '{id:"openaiImages",credential:"openaiImages",note:"Official OpenAI API - GPT Image 2 only",models:["gpt-image-2"]},'
    for lane in ('images', 'refedits', 'thumbnails'):
        pattern = re.compile(r'(\{id:"' + lane + r'",label:.*?legs:\[)(\{id:"cliProxy"[^}]+\},)')
        matches = list(pattern.finditer(text))
        if len(matches) != 1:
            raise RuntimeError('OpenAI Images UI fingerprint mismatch: ' + lane)
        extra = leg
        if lane == 'thumbnails':
            extra += '{id:"openlux",credential:"openlux",note:"OpenLux reference thumbnail fallback",models:["gpt-image-2"]},'
        match = matches[0]
        text = text[:match.end()] + extra + text[match.end():]
    for lane in ('images', 'refedits'):
        text = replace_once(text, lane + ':["wavespeed","openlux"', lane + ':["openaiImages","wavespeed","openlux"', 'optional UI lane ' + lane)
    text = replace_once(text, 'thumbnails:["69labs"]', 'thumbnails:["69labs","openaiImages","openlux"]', 'optional thumbnail UI lanes')
    return text + '\n' + UI_MARK + '\n'
