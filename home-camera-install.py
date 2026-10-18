"""Exact native camera wrapper; never patch the camera algorithm or RAM gate."""
MARKER='/* vf-custom:home-camera-v1 */'
def install_expression(module='__vfCamera'):
    return (module+'.installHomeCamera({scheduler:Me,getState:()=>globalThis.__vfSchedulerLane("ffmpeg"),'
      'getSlotMeasurer:()=>YBe,setSlotMeasurer:v=>{YBe=v},getContext:()=>fhe.getStore(),'
      'getRender:()=>SWe,setRender:v=>{SWe=v},'
      'hash:s=>process.getBuiltinModule("crypto").createHash("sha256").update(s).digest("hex"),'
      'enabled:()=>!Ca()&&__vfCustom.modEnabled("homeQueue")&&__vfCustom.modEnabled("homeFfmpeg"),'
      'makeRequest:r=>XDn({sourceUrl:"source"+process.getBuiltinModule("path").extname(r.imagePath).toLowerCase(),durationSeconds:r.durationSeconds,motion:r.motion}),'
      'runCli:async(r,signal)=>{const payload={imagePath:r.imagePath,targetPath:r.targetPath,render:r.render};'
      'const result=await qAt(process.execPath,["/app/server/dist/vf-custom/home-camera-cli.mjs",Buffer.from(JSON.stringify(payload)).toString("base64")],{signal,timeoutMs:660000});return JSON.parse(result.stdout)},'
      'runRecovery:(scope,fn,signal)=>globalThis.__vfHomeQueue.runRecovery(scope,fn,signal),'
      'validScope:scope=>globalThis.__vfHomeQueue.validScope(scope),'
      'runNativeContext:(scope,fn)=>{const c=fhe.getStore(),old=c?.leases?.get("ffmpeg");'
      'if(!c||old?.boosted?.nonce!==scope.nonce)throw Error("Native camera scope mismatch");'
      'const leases=new Map(c.leases);leases.set("ffmpeg",{...old,boosted:false});return fhe.run({...c,leases},fn)},'
      'record:(scope,r)=>Fe.info({jobId:scope.jobId,output:r.targetPath,backend:"NVENC High"},"(GPU) Image camera rendered on Home PC [NVENC High]")})')
def patch_node(text):
    if MARKER in text:return text
    for anchor in ['async function SWe(', 'function XDn(', 'fhe.getStore()', 'YBe=']:
        if anchor not in text:raise RuntimeError('Camera native fingerprint changed: '+anchor)
    return text+'\n'+MARKER+'\nimport * as __vfCamera from "./vf-custom/home-camera.mjs";\n'+(
      ';(()=>{let timer;const connect=()=>{if(!globalThis.__vfHomeQueue)return;try{'
      +install_expression()+';clearInterval(timer)}catch(e){clearInterval(timer);__vfCustom.report("homeCamera",false,e.name)}};'
      'timer=setInterval(connect,500);timer.unref();connect()})();\n')
