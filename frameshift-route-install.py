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
    'function RU(){return Jbr.getStore()?.jobId||null}',
    'function mF(e){return e==="fflow"?"ffmpeg":V0i.has(e)?"render":e}',
    'Xl=()=>cbr.getStore()', 'fhe=new $Pr', 'jp=new Map', 'isJobAborted:Cbi', 'function Cbi(e){return j0.has(e)}',
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
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required frameshift route hook duplicated')
        return text
    for anchor in NATIVE_ANCHORS:
        if text.count(anchor) < 1:
            raise RuntimeError('Required frameshift route native anchor missing: ' + anchor[:40])
    hook = (
        f'\n{MARKER};try{{__vfCustom.installFrameshiftRoute({{RU:()=>RU(),getStore:()=>fhe.getStore(),mF:e=>mF(e),'
        'getJobs:()=>jp,Xl:()=>Xl(),isJobAborted:e=>Cbi(e)});'
        '__vfCustom.report("frameshiftRoute",true)}catch(e){__vfCustom.report("frameshiftRoute",false,String(e))}\n'
    )
    return text + hook
