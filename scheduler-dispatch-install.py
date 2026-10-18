"""Expose the native scheduler dispatcher to vf-custom (node/siglip-native-cap.cjs).

The dispatcher returns the first admissible waiter of a lane (`function X(e,t,r,n){let o=null;for(let i
of t.waiters){let a=ADMIT(e,i.jobId,r,i.resourceKey,i.priority);if(a===null)return{waiter:i,reason:null};`).
This patch publishes it as globalThis.__vfSchedulerDispatch with a setter, so the SigLIP native cap
can wrap it for the siglip lane only.
"""
import re

MARKER = '/* vf-custom:scheduler-dispatch-v1 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required scheduler dispatch hook duplicated')
        return text
    found = re.findall(r'function ([\w$]+)\(e,t,r,n\)\{let o=null;for\(let i of t\.waiters\)\{let a=[\w$]+\(e,i\.jobId,r,i\.resourceKey,i\.priority\);'
                       r'if\(a===null\)return\{waiter:i,reason:null\};', text)
    if len(found) != 1:
        raise RuntimeError('Required scheduler dispatch fingerprint missing or ambiguous')
    name = found[0]
    hook = ('Object.defineProperty(globalThis,"__vfSchedulerDispatch",'
            '{configurable:true,get(){return ' + name + '},set(v){' + name + '=v}})')
    return text + '\n' + MARKER + ';try{' + hook + '}catch{}\n'
