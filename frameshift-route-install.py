"""Single Home-GPU route for every Frameshift render (node/home-graphics/motion-offload/frameshift-route.cjs).

Build-time patch of the bundled @vidforge/frameshift library: its exported `render`,
`runRender` and `materializeProject` bindings get a thin trampoline that calls
globalThis.__vfFrameshiftRoute when installed (else the original, unchanged). ESM
importers see the live binding, so even provider objects created long before a
render runs reach the route. The main-bundle tail hook installs the route with
the native licensing/lease accessors (exact anchors pinned with the Motion hook).
"""
from pathlib import Path
import re

MARKER = '/* vf-custom:frameshift-route-v1 */'
LIBRARY = {
    'render.js': ('render', 'export async function render({'),
    'hyperframes-cli.js': ('runRender', 'export async function runRender(params) {'),
    'project.js': ('materializeProject', 'export async function materializeProject(workDir, compositionHtml) {'),
}
NATIVE_ANCHORS = (
    'function w8(){return skr.getStore()?.jobId||null}',
    'function YL(e){return e==="fflow"?"ffmpeg":jRi.has(e)?"render":e}',
    'cl=()=>aSr.getStore()', 'S0e=new iQr', 'af=new Map', 'isJobAborted:SNi', 'function SNi(e){return hb.has(e)}',
)


def trampoline(name):
    return (f'\n{MARKER}\n{{const original={name};{name}=async function {name}(...args){{'
            'const route=globalThis.__vfFrameshiftRoute;'
            f'return route?route.call("{name}",original,this,args):Reflect.apply(original,this,args)}};}}\n')


def patch_library_file(text, filename):
    name, anchor = LIBRARY[filename]
    if MARKER in text:
        if text.count(MARKER) != 1 or text.count(trampoline(name)) != 1:
            raise RuntimeError('Required frameshift route trampoline drifted: ' + filename)
        return text
    if text.count(anchor) != 1 or len(re.findall(r'\b' + name + r'\s*=', text)) != 0:
        raise RuntimeError('Required frameshift library fingerprint missing or ambiguous: ' + filename)
    return text + trampoline(name)


def patch_library(directory):
    directory = Path(directory)
    changed = {}
    for filename in LIBRARY:
        path = directory / filename
        text = path.read_text(encoding='utf-8')
        updated = patch_library_file(text, filename)
        if updated != text:
            path.write_text(updated, encoding='utf-8')
        changed[filename] = updated != text
    return changed


def patch_node(text):
    for anchor in NATIVE_ANCHORS:
        if text.count(anchor) < 1:
            raise RuntimeError('Required frameshift route native anchor missing: ' + anchor[:40])
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required frameshift route hook duplicated')
        return patch_motion_admission(text)
    for anchor in NATIVE_ANCHORS:
        if text.count(anchor) < 1:
            raise RuntimeError('Required frameshift route native anchor missing: ' + anchor[:40])
    hook = (
        f'\n{MARKER};try{{__vfCustom.installFrameshiftRoute({{RU:()=>w8(),getStore:()=>S0e.getStore(),mF:e=>YL(e),'
        'getJobs:()=>af,Xl:()=>cl(),isJobAborted:e=>SNi(e)});'
        '__vfCustom.report("frameshiftRoute",true)}catch(e){__vfCustom.report("frameshiftRoute",false,String(e))}\n'
    )
    return patch_motion_admission(text + hook)


MOTION_MARKER = '/* vf-custom:home-motion-admission-v1 */'


def motion_dependencies():
    return ('{scheduler:Oe,getState:()=>DJ("render"),getContext:()=>S0e.getStore(),'
            'claim:w=>{const c=Qv.get("render"),p=c?.probing;sNi("render",DJ("render"),w);if(c&&Qv.get("render")===c)c.probing=p},'
            'getAdmission:()=>A5e,setAdmission:v=>{A5e=v},getRelease:()=>Rkt,setRelease:v=>{Rkt=v},'
            'getSlotMeasurer:()=>y5e,setSlotMeasurer:v=>{y5e=v},getEstimate:()=>fK,setEstimate:v=>{fK=v},isMock:()=>j3(),'
            'runIndependent:fn=>{const c=S0e.getStore();if(!c)return fn();const lanes=new Set(c.lanes),leases=new Map(c.leases);'
            'lanes.delete("render");leases.delete("render");return S0e.run({...c,lanes,leases},fn)}}')


def patch_motion_admission(text):
    if MOTION_MARKER in text:
        if text.count(MOTION_MARKER) != 1:
            raise RuntimeError('Duplicate Motion admission hook')
        return text
    for anchor in ('function sNi(e,t,r,{boosted:n=!1}={})', 'function A5e(e,t,r,n=e,o=Ikt(t))',
                   'async function Rkt(e,t,r,n=e,o=!1)', 'function fK({resourceKey:e,opKey:t=null,quality:r=null,jobId:n=null}={})',
                   'function j3()', 'boosted:y?.homeScope||!!y?.boosted', 'resourceKey:A.boosted&&typeof A.boosted==="object"?"ffmpegHome":i'):
        if text.count(anchor) != 1:
            raise RuntimeError('Required Motion admission anchor changed: '+anchor)
    # Load after native scheduler/slot sampler and the existing Frameshift route.
    return text + ('\n'+MOTION_MARKER+';{let timer;const connect=()=>{try{if(!globalThis.__vfFrameshiftRoute||!y5e)return;'
                   '__vfCustom.installHomeMotionAdmission('+motion_dependencies()+');clearInterval(timer);'
                   '__vfCustom.report("homeMotionAdmission",true)}catch(e){clearInterval(timer);'
                   '__vfCustom.report("homeMotionAdmission",false,String(e))}};timer=setInterval(connect,1000);timer.unref();connect()}\n')
