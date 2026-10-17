import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('only confirmed NVENC output emits a native GPU event with exact scope', async () => {
  const file=new URL('../node/gpu-render-events.mjs',import.meta.url);
  assert.equal(fs.existsSync(file),true,'native GPU event annotator is not implemented');
  const {createGpuRenderListener}=await import(file);
  const emitted=[];
  const listener=createGpuRenderListener({emit:event=>emitted.push(event),probe:async()=>({
    streams:[{codec_type:'video',codec_name:'h264',profile:'High',pix_fmt:'yuv420p',tags:{encoder:'Lavc h264_nvenc'}}]})});
  const event={jobId:'exact-job',chunkId:'exact-chunk',step:'chunkRender',message:'Rendered chunk 4',data:{chunkVideoPath:'/data/projects/exact/chunks/chunk_4.mp4'}};
  const before=JSON.stringify(event);
  listener(event);await listener.idle();
  assert.equal(emitted.length,1);
  assert.equal(emitted[0].jobId,event.jobId);
  assert.equal(emitted[0].chunkId,event.chunkId);
  assert.match(emitted[0].message,/^\(GPU\) Rendered chunk 4/);
  assert.equal(JSON.stringify(event),before,'native event was mutated');
  listener(event);listener(emitted[0]);await listener.idle();
  assert.equal(emitted.length,1,'duplicates or recursive annotations');
});

test('CPU, unknown output, unsafe paths and probe failures never claim GPU or block rendering', async () => {
  const file=new URL('../node/gpu-render-events.mjs',import.meta.url);
  assert.equal(fs.existsSync(file),true,'native GPU event annotator is not implemented');
  const {createGpuRenderListener}=await import(file);
  for (const probe of [async()=>({streams:[{codec_type:'video',tags:{encoder:'libx264'}}]}),async()=>{throw Error('gone')}]) {
    const emitted=[];
    const listener=createGpuRenderListener({emit:e=>emitted.push(e),probe});
    for (const path of ['/data/projects/a/chunks/chunk_1.mp4','https://example.org/video.mp4','/etc/secret.mp4'])
      listener({jobId:'j',step:'chunkRender',message:'Rendered chunk 1',data:{chunkVideoPath:path}});
    await listener.idle();assert.equal(emitted.length,0);
  }
});
