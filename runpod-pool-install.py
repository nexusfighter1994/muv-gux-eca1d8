"""RunPod GPU-FFmpeg pool: REST v2, NVENC self-test fix, bounded waiting, queue-driven on/off (2026-11-16).

Owner 16.11.: "Runpod soll sich deaktivieren sobald in ffmpeg unter 800 dinge ist und sich wieder aktivieren
sobald 2000 dinge gequed sind ... Hot und baus dann so das es bei nem neustart fix ist".
The logic lives in node/runpod-pool.cjs (see its header for the eight fixes). This installer only appends one
tail hook that hands the helper getters/setters for the native pool bindings. The pool module initialises
lazily, so the helper polls native.ready() before it touches anything. Hot knob: /data/runtime/vf-runpod-pool.json.
"""
import re

MARKER = '/* vf-custom:runpod-pool-v1 */'


def _one(pattern, text, what):
    found = re.findall(pattern, text)
    if len(found) != 1:
        raise RuntimeError(f'RunPod pool fingerprint missing or ambiguous ({len(found)}): {what}')
    return found[0]


def names(text):
    image_fn, box, image_var = _one(r'function ([\w$]+)\(\)\{return ([\w$]+)\.override\|\|([\w$]+)\}', text, 'image override')
    if not re.search(re.escape(image_var) + r'="afflicted9436/[\w.-]+:[\w.-]+"', text):
        raise RuntimeError('RunPod pool fingerprint: pod image constant not found')
    n = {
        'box': box,
        'timing': _one(r'([\w$]+)=\{statusPollMs:5e3,healthPollMs:1e4,', text, 'pod timing'),
        'offers': _one(r'([\w$]+)=\d+,[\w$]+=new Set\(\["terminated","lost","create_failed","boot_timeout","heartbeat_timeout"\]\)', text, 'offer count'),
        'gpuList': _one(r'async function ([\w$]+)\(\{settings:e=[\w$]+\(\)\}=\{\}\)\{let t=[\w$]+\(\),r=e\.allowCommunityCloud!==!1', text, 'gpu list'),
        'kt': _one(r'a=await ([\w$]+)\(`\$\{[\w$]+\}/pods`,\{method:"POST",headers:', text, 'pod create request'),
        'api': _one(r'([\w$]+)=\{acquire:[\w$]+,registerJob:', text, 'pool api'),
        'pool': _one(r'([\w$]+)=\{pods:\[\],waiters:\[\],spinups:new Set,activeJobs:new Set', text, 'pool state'),
        'readyPods': _one(r'function ([\w$]+)\(\)\{return [\w$]+\.pods\.filter\(e=>e\.state==="ready"\)\}', text, 'ready pods'),
        'podUsable': _one(r'function ([\w$]+)\(e,t=[\w$]+\(\)\)\{return e\.image===[\w$]+\(\)&&e\.costPerHr<=', text, 'usable pod'),
        'freePod': _one(r'function ([\w$]+)\(e\)\{return e\.filter\(t=>t\.state==="ready"&&t\.inflight<', text, 'free pod'),
        'settings': _one(r'function ([\w$]+)\(\)\{let\{ffmpegImage:e,\.\.\.t\}=[\w$]+\(\)\.runpod\|\|\{\};', text, 'runpod settings'),
        'saveSettings': _one(r'function ([\w$]+)\(e\)\{let\{ffmpegImage:t,\.\.\.r\}=e\|\|\{\};[\w$]+\(\{runpod:\{\.\.\.', text, 'save runpod settings'),
        'terminate': _one(r'async function ([\w$]+)\(e,t,\{finalState:r="terminated",lastError:n=null,failureError:o=', text, 'terminate pod'),
        'reprobe': _one(r'async function ([\w$]+)\(e\)\{let\[t,r\]=await Promise\.all\(\[[\w$]+\(e,[\w$]+\.siglip\),[\w$]+\(e,[\w$]+\.render\)\]\)', text, 'capability probe'),
        'spin': _one(r'function ([\w$]+)\(e\)\{[\w$]+\(\),[\w$]+\(\);let t=[\w$]+\.waiters\[0\]\?\.jobId\|\|e,r=', text, 'pod spin-up'),
        'lane': _one(r'function ([\w$]+)\(([\w$]+)\)\{let ([\w$]+)=[\w$]+\.get\(\2\);return \3\|\|\(\3=\{activeTotal:0,activeByJob:new Map', text, 'lane state')[0],
    }
    key, kt2, gql_url = _one(r'let t=([\w$]+)\(\),r=e\.allowCommunityCloud!==!1,o=await ([\w$]+)\(([\w$]+),\{method:"POST",json:\{query:`query GpuTypes', text, 'gpu list request')
    n['key'], n['gqlUrl'] = key, gql_url
    n['renderFetch'] = _one(r'([\w$]+)=\{fn:\(\.\.\.e\)=>globalThis\.fetch\(\.\.\.e\)\}', text, 'render agent fetch')
    n['headers'] = _one(r'`\},headers:([\w$]+)\(t\),provider:"runpod",timeoutMs:[\w$]+\.requestTimeoutMs\}\),i=[\w$]+\(e\),s=\[\];for\(let a of o\?\.data\?\.gpuTypes', text, 'graphql headers')
    return n


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('RunPod pool hook duplicated')
        return text
    n = names(text)
    obj = lambda v: f'typeof {v}==="object"&&{v}!==null'
    hook = (
        f'\n{MARKER};(()=>{{try{{__vfCustom.installRunpodPool({{'
        f'ready:()=>{obj(n["api"])}&&{obj(n["timing"])}&&{obj(n["box"])}&&{obj(n["pool"])},'
        f'pool:()=>{n["pool"]},timing:()=>{n["timing"]},overrideBox:()=>{n["box"]},setOfferCount:v=>{{{n["offers"]}=v}},'
        f'getKt:()=>{n["kt"]},setKt:f=>{{{n["kt"]}=f}},getGpuList:()=>{n["gpuList"]},setGpuList:f=>{{{n["gpuList"]}=f}},'
        f'api:()=>{n["api"]},readyPods:()=>{n["readyPods"]}(),podUsable:p=>{n["podUsable"]}(p),freePod:l=>{n["freePod"]}(l),'
        f'settings:()=>{n["settings"]}(),saveSettings:p=>{n["saveSettings"]}(p),lane:k=>{n["lane"]}(k),terminatePod:(p,r)=>{n["terminate"]}(p,r),reprobe:p=>{n["reprobe"]}(p),spin:j=>{n["spin"]}(j),'
        f'renderFetchBox:()=>{n["renderFetch"]},'
        f'gql:q=>{n["kt"]}({n["gqlUrl"]},{{method:"POST",json:{{query:q}},headers:{n["headers"]}({n["key"]}()),provider:"runpod",timeoutMs:30000}})}});'
        '__vfCustom.report("runpodPool",true)}catch(e){__vfCustom.report("runpodPool",false,String(e))}})();\n'
    )
    return text + hook


if __name__ == '__main__':
    import sys
    src = open(sys.argv[1], encoding='utf-8').read()
    print(names(src))
    if len(sys.argv) > 2:
        out = patch_node(src)
        open(sys.argv[2], 'w', encoding='utf-8', newline='').write(out)
        print('written', sys.argv[2], len(out) - len(src), 'bytes added')
