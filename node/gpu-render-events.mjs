export function createGpuRenderListener({emit, probe}) {
  const seen=new Set();
  const stats={checked:0,emitted:0,skipped:0};
  let chain=Promise.resolve(),pending=0;
  const listener=event=>{
    const path=event?.data?.chunkVideoPath || event?.data?.videoPath || event?.data?.outputPath;
    if (!event?.jobId || event?.data?.gpuAnnotation || ['warn','error'].includes(event?.level)
      || !/rendered|completed|ready/i.test(event?.message||'') || typeof path!=='string'
      || !/^\/data\/(projects|engines\/fflow)\/[^\r\n]+\.mp4$/i.test(path)
      || path.split('/').includes('..') || seen.has(path) || pending>=32) return;
    seen.add(path);
    if(seen.size>2000)seen.delete(seen.values().next().value);
    pending++;
    chain=chain.then(async()=>{
      try {
        stats.checked++;
        const data=await probe(path);
        const stream=data?.streams?.find(s=>s.codec_type==='video');
        if(stream?.codec_name!=='h264'||stream.profile!=='High'||stream.pix_fmt!=='yuv420p'
          || !/\bh264_nvenc\b/i.test(stream?.tags?.encoder||'')) {stats.skipped++;return;}
        emit({jobId:event.jobId,chunkId:event.chunkId??null,segmentId:event.segmentId??null,
          step:event.step||'chunkRender',level:'info',
          message:`(GPU) ${event.message} [Home PC NVENC High]`,
          data:{...event.data,gpuAnnotation:true,encoder:'h264_nvenc',gpuPolicy:'nvenc-high-qp14-v1'}});
        stats.emitted++;
      } catch {stats.skipped++;} finally {pending--;}
    });
  };
  listener.idle=()=>chain;
  listener.stats=()=>({...stats,pending});
  return listener;
}

export function installGpuRenderEvents({getEmitter, emit}) {
  const key=Symbol.for('vf.gpuRenderEventFeed');
  const child=process.getBuiltinModule('child_process');
  const probe=path=>new Promise((resolve,reject)=>child.execFile('ffprobe',
    ['-v','error','-select_streams','v:0','-show_streams','-of','json',path],
    {timeout:10000,maxBuffer:262144},(error,stdout)=>{
      if(error)return reject(error);
      try{resolve(JSON.parse(stdout))}catch(e){reject(e)}
    }));
  const connect=()=>{
    const emitter=getEmitter();
    if(!emitter?.on)return false;
    if(!emitter[key]){
      const listener=createGpuRenderListener({emit,probe});
      emitter.on('event',listener);emitter[key]=listener;
    }
    return true;
  };
  if(!connect()){
    let attempts=0;
    const timer=setInterval(()=>{if(connect()||++attempts>=40)clearInterval(timer)},500);
    timer.unref();
  }
}
