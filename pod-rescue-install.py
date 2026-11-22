"""Pod rescue: queued local animations stay open to free RunPod pod slots (node/pod-rescue.cjs, 2026-11-21).

Owner 21.11.: "Wieso kamen keine animationen ueber den pod? Fixe das das soll klappen!". The app asks the pool
only when an animation starts (rendererLane -> pod path -> acquire); a busy, booting or missing pod sends it to
the local render lane for good. This installer appends one tail hook that hands node/pod-rescue.cjs the native
names it needs; the helper polls until the scheduler and pool exist. Hot knob: /data/runtime/vf-pod-rescue.json.
"""
import re

MARKER = '/* vf-custom:pod-rescue-v1 */'


def _one(pattern, text, what):
    found = re.findall(pattern, text)
    if len(found) != 1:
        raise RuntimeError(f'Pod rescue fingerprint missing or ambiguous ({len(found)}): {what}')
    return found[0]


def names(text):
    return {
        'od': _one(r'rendererLane:\(\)=>([\w$]+)[,}]', text, 'rendererLane export'),
        'dxe': _one(r'async function ([\w$]+)\(e,t,r,\{workload:n="compositions",passThrough:o=null\}=\{\}\)', text, 'pod path'),
        'xfn': _one(r'function ([\w$]+)\(e\)\{let t=[\w$]+\(\);return t\?\.remote&&t\.workload===e&&t\.renderBaseUrl\?t:null\}', text, 'remote context'),
        'poolOn': _one(r'function ([\w$]+)\(e,t=[\w$]+\(\)\)\{return t\?\.gpuFfmpegEnabled\?t\.workloads\?\.\[e\]!==!1:!1\}', text, 'workload on'),
        'settings': _one(r'function ([\w$]+)\(\)\{let\{ffmpegImage:e,\.\.\.t\}=[\w$]+\(\)\.runpod\|\|\{\};', text, 'runpod settings'),
        'readyPods': _one(r'function ([\w$]+)\(\)\{return [\w$]+\.pods\.filter\(e=>e\.state==="ready"\)\}', text, 'ready pods'),
        'podUsable': _one(r'function ([\w$]+)\(e,t=[\w$]+\(\)\)\{return e\.image===[\w$]+\(\)&&e\.costPerHr<=', text, 'usable pod'),
        'slots': _one(r'function ([\w$]+)\(e\)\{let t=Number\(e\?\.vramGb\),r=Number\.isFinite\(t\)&&t>0,n=Math\.floor\(Number\(e\?\.targetSlots\)\)', text, 'effective slots'),
        'pool': _one(r'([\w$]+)=\{pods:\[\],waiters:\[\],spinups:new Set,activeJobs:new Set', text, 'pool state'),
        'api': _one(r'([\w$]+)=\{acquire:[\w$]+,registerJob:', text, 'pool api'),
        'lane': _one(r'function ([\w$]+)\(([\w$]+)\)\{let ([\w$]+)=[\w$]+\.get\(\2\);return \3\|\|\(\3=\{activeTotal:0,activeByJob:new Map', text, 'lane state')[0],
        'scheduler': _one(r'if\(([\w$]+)\.isJobAborted\(e\)\)\{let l=new Error\("Render job stopped"\)', text, 'scheduler'),
    }


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Pod rescue hook duplicated')
        return text
    n = names(text)
    hook = (
        f'\n{MARKER};(()=>{{try{{__vfCustom.installPodRescue({{'
        f'ready:()=>typeof {n["scheduler"]}==="object"&&{n["scheduler"]}!==null&&typeof {n["scheduler"]}.run==="function"'
        f'&&typeof {n["pool"]}==="object"&&{n["pool"]}!==null&&typeof {n["api"]}==="object"&&{n["api"]}!==null,'
        f'scheduler:()=>{n["scheduler"]},od:{{get:()=>{n["od"]},set:v=>{{{n["od"]}=v}}}},native:{{'
        f'podFreeSlots:()=>{{if(!{n["settings"]}()?.gpuFfmpegEnabled)return 0;let f=0;for(const x of {n["readyPods"]}()){{'
        f'if(!{n["podUsable"]}(x)||x.capabilities?.render===!1||x.disabledServices?.has?.("render"))continue;'
        f'f+=Math.max(0,{n["slots"]}(x)-(x.inflight||0))}}return Math.max(0,f-({n["pool"]}.waiters?.length||0))}},'
        f'podPresent:()=>({n["pool"]}.pods||[]).some(x=>x.state==="ready"||x.state==="booting")||({n["pool"]}.spinups?.size||0)>0,'
        f'poolOn:w=>{n["poolOn"]}(w),'
        f'spinup:j=>{{Promise.resolve().then(()=>{n["api"]}.acquire({{jobId:j,checkCanceled(){{}}}})).then(l=>{{try{{l&&l.release&&l.release()}}catch{{}}}},()=>{{}})}},'
        f'dxe:(j,l,f,o)=>{n["dxe"]}(j,l,f,o),isRemote:w=>!!{n["xfn"]}(w),'
        f'jobPriorities:()=>{{const m=new Map();for(const w of {n["lane"]}("render").waiters){{const p=String(w.priority),c=m.get(w.jobId);if(c===undefined||p<c)m.set(w.jobId,p)}}return m}}}}}});'
        '__vfCustom.report("podRescue",true)}catch(e){__vfCustom.report("podRescue",false,String(e))}})();\n'
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
