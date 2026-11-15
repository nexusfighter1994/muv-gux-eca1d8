const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const {createSafeJoin, entries} = require('../node/bounded-safe-join.cjs');

for (const hasAudio of [true,false]) {
  test(`fractional-frame PCM normalization uses exact sample counts (audio=${hasAudio})`, async t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vf-sample-unit-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const input=path.join(dir,'input.mp4'),target=path.join(dir,'final.mp4');
    fs.writeFileSync(input,'source');
    const info={streams:[{codec_type:'video',codec_name:'h264',profile:'High',pix_fmt:'yuv420p',width:64,height:64,r_frame_rate:'24/1',duration:'19.041667',nb_frames:'457'},
      ...(hasAudio?[{codec_type:'audio',codec_name:'aac',duration:'19.046'}]:[])],format:{duration:'19.046'}};
    const outputs=new Map([[input,info]]);
    let observed=false;
    const run=async args=>{
      const out=args.at(-1),normalized=out.endsWith('.mov');
      if(normalized){
        const filters=args[args.indexOf('-filter_complex')+1];
        assert.ok(filters.includes('atrim=end_sample=914000,asetpts=N/SR/TB[a]'));
        assert.ok(filters.includes(hasAudio?'[0:a:0]':'anullsrc='));
        assert.ok(!filters.includes('atrim=0:'));
        observed=true;
      }
      outputs.set(out,{streams:[info.streams[0],{codec_type:'audio',codec_name:normalized?'pcm_s24le':'aac',duration:'19.041667'}],format:{duration:'19.041667'}});
      fs.writeFileSync(out,'output');
    };
    const probe=async args=>({code:0,stdout:JSON.stringify(outputs.get(args.at(-1)))});
    const result=await createSafeJoin({probe,run,validateCopy:()=>({ok:false})})({chunkPaths:[input],targetPath:target});
    assert.ok(observed);
    assert.equal(result.frameCount,457);
    assert.equal(fs.readFileSync(input,'utf8'),'source');
  });
}

test('real chunk 5 keeps 457 frames and exact PCM sample duration despite AAC timestamps', {skip:!process.env.VF_JOIN_FIXTURE}, async t => {
  const input = path.resolve(process.env.VF_JOIN_FIXTURE);
  const ffmpeg = process.env.VF_TEST_FFMPEG;
  const ffprobe = process.env.VF_TEST_FFPROBE;
  assert.ok(ffmpeg && ffprobe);
  const before = fs.readFileSync(input);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'vf-sample-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let normalized;
  const probe = async args => ({code:0,...await exec(ffprobe,args,{timeout:60000,maxBuffer:1024*1024,windowsHide:true})});
  const run = async args => {
    await exec(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n',...args],{timeout:120000,maxBuffer:1024*1024,windowsHide:true});
    if (args.at(-1).endsWith('.mov')) normalized=JSON.parse((await probe(['-v','error','-show_entries',entries,'-of','json',args.at(-1)])).stdout);
  };
  const target=path.join(dir,'final.mp4');
  const joined=await createSafeJoin({probe,run,validateCopy:()=>({ok:false,reason:'force real normalization regression'})})({chunkPaths:[input],targetPath:target});
  assert.equal(joined.frameCount,457);
  const audio=normalized.streams.find(s=>s.codec_type==='audio');
  assert.equal(Number(audio.nb_frames),914000);
  assert.ok(Math.abs(Number(audio.duration)-914000/48000)<1/48000);
  assert.deepEqual(fs.readFileSync(input),before);
  assert.equal(joined.method,'bounded-reencode');
});
