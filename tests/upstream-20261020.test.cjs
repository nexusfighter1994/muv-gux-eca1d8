const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const identity=require('../node/thumbnail-subject-identity.cjs');
const root=path.resolve(__dirname,'..');
const builders=JSON.parse(fs.readFileSync(path.join(root,'thumbnail-identity/native-builders.json'))).functions;
const context=vm.createContext({TL:n=>Math.max(1,Math.min(4,n))});
const writer=vm.runInContext('('+builders.writer.source+')',context);

test('new Packaging prompt keeps script moments, native variant composition and named subjects',()=>{
  for(const count of [1,2,3,4]){
    const original=writer({language:'English',count});
    const patched=identity.updateWriterPrompt(original);
    assert.match(patched,/REAL SUBJECT IDENTITY/);
    assert.doesNotMatch(patched,/IDENTITY LAYER \(must be visibly DIFFERENT/);
    assert.match(patched,/Walter R\u00f6hrl/);
    assert.match(patched,/Return 8-12 moments and exactly /);
    assert.match(patched,/["']?core_promise["']?/);
    assert.match(patched,/other variants\ninherit its style/);
    assert.match(patched,/keeping a reference person only if the NEW video requires that person/);
    assert.equal(identity.updateWriterPrompt(patched),patched);
    assert.match(patched,/STEP 2/);
    assert.match(patched,/moment_id/);
    assert.match(patched,/overlay_text/);
  }
});

test('native wordSync persistence retires custom insertion; legacy omission still receives the fix',()=>{
  const script=`import runpy,sys\nm=runpy.run_path(sys.argv[1]);src='let B=E(M,O)&&(!["text_overlay"].includes(M.type)||O.wordSyncVersion===n1e),D=O.smartOverlay||null;S.run({provider_outputs_json:JSON.stringify({plannedType:O.plannedType||M.type,finalType:O.finalType,...O.wordSyncVersion!=null?{wordSyncVersion:O.wordSyncVersion}:{}})})'\nassert m['patch_node'](src)==src\nlegacy=src.replace(',...O.wordSyncVersion!=null?{wordSyncVersion:O.wordSyncVersion}:{}','')\nassert 'vf-custom:segment-wordsync-v1' in m['patch_node'](legacy)\ntry:m['patch_node'](src.replace('O.wordSyncVersion===n1e','O.other===n1e'));raise AssertionError('drift accepted')\nexcept RuntimeError:pass\nprint('native retirement and old omission verified')`;
  assert.match(execFileSync('python',['-c',script,path.join(root,'segment-wordsync-install.py')],{encoding:'utf8'}),/verified/);
});

test('native B-roll resume hashes include verification, slow windows and stable segment fields',()=>{
  const {broll}=JSON.parse(fs.readFileSync(path.join(root,'native-retirements.json')));
  const box=vm.createContext({h4s:['status','output_path','error','attempt_count','fallback_count','provider_outputs_json','started_at','completed_at','updated_at','revision_no','selected_revision_id'],
    w5s:1,Zzt:()=>false,vHn:()=>false,UKe:(best,duration)=>({extended:false,slowed:true,startSec:best.startSec,endSec:best.endSec,slowFactor:duration/(best.endSec-best.startSec)}),
    bHn:()=>true,qoe:()=>false,MR:()=>null});
  const native=vm.runInContext(Object.values(broll.functions).join(';')+';({Fzt:t9t,Bzt:r9t,hKe:IKe})',box);
  const input={segment:{type:'b_roll_video'},best:{videoUrl:'clip',startSec:2,endSec:4},durationSec:4,outputPath:'out.mp4',creditAuthor:true,textFilter:true};
  const resume=JSON.parse(JSON.stringify(native.Bzt(input)));
  assert.deepEqual(resume,[{best:input.best,durationSec:4,outputPath:'out.mp4',creditAuthor:true,window:{startSec:2,endSec:4},slow:2,verify:1}]);
  const a={id:'segment',context:'Original',duration_sec:4,status:'rendering',attempt_count:2,revision_no:1};
  const b={...a,status:'succeeded',output_path:'out.mp4',attempt_count:3,updated_at:'later',selected_revision_id:'revision'};
  assert.deepEqual(JSON.parse(JSON.stringify(native.hKe(a))),JSON.parse(JSON.stringify(native.hKe(b))));
  assert.equal(native.hKe({...a,context:'Changed'}).context,'Changed');
  const script="import runpy,sys; m=runpy.run_path(sys.argv[1]); s=open(sys.argv[2],encoding='utf8').read(); assert m['patch_node'](s)==s; print('retired')";
  if(fs.existsSync(path.join(root,'stock.mjs')))assert.match(execFileSync('python',['-c',script,path.join(root,'broll-reuse-install.py'),path.join(root,'stock.mjs')],{encoding:'utf8'}),/retired/);
});
