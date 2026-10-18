"""Expose the native scheduler lane state to vf-custom (node/runpod/burst-controller.cjs).

The scheduler keeps one state object per lane (`function X(e){let t=M.get(e);return t||(t={activeTotal:0,
activeByJob:new Map,activeByResource:new Map,waiters:[],...},M.set(e,t)),t}`). The RunPod burst
controller reads how many frameshift renders wait in the render lane. This patch publishes
the lane getter as globalThis.__vfSchedulerLane (read-only use).
"""
import re

MARKER = '/* vf-custom:scheduler-lane-v1 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required scheduler lane hook duplicated')
        return text
    found = re.findall(r'function ([\w$]+)\(([\w$]+)\)\{let ([\w$]+)=[\w$]+\.get\(\2\);return \3\|\|\(\3=\{activeTotal:0,'
                       r'activeByJob:new Map,activeByResource:new Map,waiters:\[\]', text)
    if len(found) != 1:
        raise RuntimeError('Required scheduler lane fingerprint missing or ambiguous')
    name = found[0][0]
    hook = ('Object.defineProperty(globalThis,"__vfSchedulerLane",'
            '{configurable:true,get(){return ' + name + '}})')
    return text + '\n' + MARKER + ';try{' + hook + '}catch{}\n'
