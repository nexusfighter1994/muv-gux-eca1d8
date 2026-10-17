const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {timelineCueV2}=require('./semantic-cue.cjs'),{patchTimeline}=require('./candidate.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const CHILD='6db6c25c54b16cf00948d2dfc35e79c38e960582abd0a93a30016be5f362cc38',TS='ed37a1ddeb2924de32aff47ecf2abf76c6bae0f5aab9230fe3d8f2201e21d887',SHARED='5831d6cba65a7870a1c0eeebab93f215cb45bcba985c5efe4f06c2a105612446';
function prepareChild({bundle,child,template,shared}){
 if(hash(child)!==CHILD||hash(template)!==TS)throw Error('Child/template hash fence failed');
 let pure='';
 for(const [name,expected] of [['CAe','12bba3c98cf8d26208f8c7fc9963b2d42b6d265a397fc4a3fdff2bab719730ba'],['IAe','320971330da7f5f5cf0a0ca30a63084cd80e4cfeb2fe991c35f555d73c148295']]){
  const a=bundle.indexOf('function '+name+'('),b=bundle.indexOf('function ',a+10),fn=bundle.slice(a,b);
  if(a<0||b<0||hash(fn)!==expected)throw Error('Native numeric helper hash fence failed');pure+=fn+'\n';
 }
 const recovery=fs.readFileSync(path.join(__dirname,'shared/spokenText.js'),'utf8');
 if(hash(recovery)!==SHARED||(shared!=null&&hash(shared)!==SHARED))throw Error('Shared module hash fence failed');
 const helper=pure+timelineCueV2.toString()+`\nexport function applyTimelineChild({compositionId,inputProps,fps,frames}) {\n if(compositionId!=='Timeline'||!Array.isArray(inputProps?.spoken_text_words)||!inputProps.spoken_text_words.length||!Number.isFinite(fps)||!(fps>0)||!Number.isFinite(frames)||!(frames>0))return inputProps;\n const spoken_cue=timelineCueV2({data:inputProps,segment:{start_s:0,duration_sec:frames/fps},words:inputProps.spoken_text_words},IAe);\n return {...inputProps,spoken_cue};\n}\n`;
 const anchor='  if (inputProps.background_url == null && inputProps.background_video_url != null) {';
 if(child.split(anchor).length!==2)throw Error('Child parse hook drift');
 const childAfter=child.replace('import { bundle } from "@remotion/bundler";','import { applyTimelineChild } from "./timeline-semantic-cue-v2.mjs";\nimport { bundle } from "@remotion/bundler";').replace(anchor,'  inputProps = applyTimelineChild({ compositionId, inputProps, fps, frames });\n\n'+anchor);
 const templateAfter=patchTimeline(template);
 return {child:childAfter,template:templateAfter,helper,shared:recovery,hook:{id:'infographicTimelineChildSemanticCueV2',childBefore:CHILD,childAfter:hash(childAfter),templateBefore:TS,templateAfter:hash(templateAfter),helper:hash(helper),shared:SHARED,appBundleChanged:false}};
}
module.exports={prepareChild};
if(require.main===module){
 const args=process.argv.slice(2),root=args[args.indexOf('--root')+1];if(!args.includes('--root')||!root)throw Error('--root required; check-only default');
 const base=path.join(root,'render/remotion-engine/remotion'),child=path.join(base,'render.mjs'),template=path.join(base,'src/compositions/Timeline/index.tsx'),shared=path.join(root,'render/shared/spokenText.js');
 const r=prepareChild({bundle:fs.readFileSync(path.join(root,'server/dist/index.mjs'),'utf8'),child:fs.readFileSync(child,'utf8'),template:fs.readFileSync(template,'utf8'),shared:fs.existsSync(shared)?fs.readFileSync(shared,'utf8'):null});
 if(args.includes('--apply')){
  // Parent backs up targets. Stage all files first; child entry is the commit point.
  const files=[[shared,r.shared],[path.join(base,'timeline-semantic-cue-v2.mjs'),r.helper],[template,r.template],[child,r.child]];
  for(const [p,s]of files){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p+'.timeline-v2.tmp',s);}
  for(const [p]of files)fs.renameSync(p+'.timeline-v2.tmp',p);
 }
 console.log(JSON.stringify(r.hook,null,2));
}
