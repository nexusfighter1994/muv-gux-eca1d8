"""Pod overflow (2026-11-22): b-roll trims that only wait for a full pod go to the local lane, where Home claims them.

Owner: "Immer wenn ein pod laeuft hab ich das gefuehl das home weniger macht geht das irgendwie besser? Dann mach".
With the pool on, every b-roll shot trim took the pod path and waited there; the local ffmpeg lane (where the Home PC
claims trims) got none: Home trims 357 / 268 per 10 min with the pool off, 34 with it on (22.11.). Logic in
node/pod-overflow.cjs: the pod keeps first call (all slots busy and a backlog waiting), then Home takes the surplus.
This installer appends one tail hook that wraps the pod path binding. Hot knob: /data/runtime/vf-pod-overflow.json.
"""
import re
import runpy
from pathlib import Path

MARKER = '/* vf-custom:pod-overflow-v1 */'
HERE = Path(__file__).resolve().parent


def _one(pattern, text, what):
    found = re.findall(pattern, text)
    if len(found) != 1:
        raise RuntimeError(f'pod overflow fingerprint missing or ambiguous ({len(found)}): {what}')
    return found[0]


def names(text):
    pod = runpy.run_path(str(HERE / 'pod-rescue-install.py'))['names'](text)
    remote = _one(r'async function ' + re.escape(pod['dxe']) + r'\(e,t,r,\{workload:n="compositions",passThrough:o=null\}=\{\}\)'
                  r'\{if\(([\w$]+)\(\)\|\|!e\|\|!' + re.escape(pod['poolOn']) + r'\(n\)\|\|', text, 'remote context check')
    # The b-roll trim must still go through the pod path with this workload and label.
    if len(re.findall(r'\([\w$]+,"brollAnalysis","B-roll shot trim",\(\)=>', text)) != 1:
        raise RuntimeError('pod overflow fingerprint missing or ambiguous: b-roll trim call')
    return {'dxe': pod['dxe'], 'remote': remote, 'poolOn': pod['poolOn'], 'pool': pod['pool'], 'slots': pod['slots']}


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('pod overflow hook duplicated')
        return text
    n = names(text)
    hook = (f'\n{MARKER};(()=>{{try{{{n["dxe"]}=__vfCustom.wrapPodOverflow({n["dxe"]},{{'
            f'isRemote:()=>!!{n["remote"]}(),poolOn:w=>{n["poolOn"]}(w),pods:()=>{n["pool"]}.pods,'
            f'slotsOf:x=>{n["slots"]}(x),waiters:()=>{n["pool"]}.waiters.length}});'
            '__vfCustom.report("podOverflow",true)}catch(e){__vfCustom.report("podOverflow",false,String(e))}})();\n')
    return text + hook


if __name__ == '__main__':
    import sys
    src = open(sys.argv[1], encoding='utf-8').read()
    print(names(src))
    if len(sys.argv) > 2:
        out = patch_node(src)
        open(sys.argv[2], 'w', encoding='utf-8', newline='').write(out)
        print('written', sys.argv[2], len(out) - len(src), 'bytes added')
