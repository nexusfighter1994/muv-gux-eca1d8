"""Independent bounded Home scene candidates; exact native callback fingerprint."""
import runpy
from pathlib import Path
MARKER='/* vf-custom:home-scenes-v1 */'
def install_expression(module='__vfScenes'):
    camera=runpy.run_path(str(Path(__file__).with_name('home-camera-install.py')))['install_expression']()
    start=camera.index('runCli:');end=camera.index('runRecovery:',start)
    camera=camera[:start]+('runCli:async(r,signal)=>{const payload={sourceUrl:r.sourceUrl,localVideoUrl:r.localVideoUrl,'
      'durationSec:r.durationSec,minShotSec:r.minShotSec,jobId:r.jobId,budgetMs:r.budgetMs};'
      'const v=await qAt("python",["-B","/app/engines/fflow/src/core/pc_scene_graphics_cli.py",'
      'Buffer.from(JSON.stringify(payload)).toString("base64")],{signal,timeoutMs:r.budgetMs+15000});return JSON.parse(v.stdout)},'
      'getPublisher:async()=>{globalThis.__vfHomeScenePublisher??=mH();const p=await globalThis.__vfHomeScenePublisher;return p.publish.bind(p)},')+camera[end:]
    start=camera.index('record:')
    camera=camera[:start]+('record:(scope,backend)=>Kt({jobId:scope.jobId,level:"info",step:"chunkRender",'
      'message:(backend.startsWith("NVDEC")?"(GPU) ":"(CPU) ")+"Scene detection completed on Home PC ["+backend+"]",data:{backend,homeScenes:true}})})')
    return camera.replace('__vfCamera.installHomeCamera',module+'.installHomeScenes').replace('()=>SWe','()=>f7i').replace('SWe=v','f7i=v').replace('modEnabled("homeFfmpeg")','modEnabled("homeScenes")')
def patch_node(text):
    if MARKER in text:return text
    if text.count('async function f7i(')!=1 or 'function mH(' not in text:raise RuntimeError('Native scenes fingerprint changed')
    return text+'\n'+MARKER+'\nimport * as __vfScenes from "./vf-custom/home-scenes.mjs";\n'+(
      ';(()=>{let timer;const connect=()=>{if(!globalThis.__vfHomeCamera)return;try{'
      +install_expression()+';clearInterval(timer)}catch(e){clearInterval(timer);__vfCustom.report("homeScenesNative",false,e.name)}};'
      'timer=setInterval(connect,500);timer.unref();connect()})();\n')
