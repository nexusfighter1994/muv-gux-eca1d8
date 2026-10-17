"""Bounded render RAM fairness at the original scheduler memory-gate boundary."""
import re

MARKER = '/* vf-custom:render-memory-fairness-v3 */'
V2_MARKER = '/* vf-custom:render-memory-fairness-v2 */'
LEGACY_MARKER = '/* vf-custom:render-memory-fairness-v1 */'


def _v2_hook(gate, setter, state, check, limit, registry):
    return (
        f'\n{V2_MARKER};try{{{gate}=__vfCustom.wrapRenderMemoryGate({gate},request=>{{'
        f'const s={state}("render"),ready=s.waiters.filter(w=>["frameshift","remotion"].includes(w.resourceKey)&&'
        f'{check}("render",w.jobId,{limit}("render"),w.resourceKey,w.priority)===null);'
        f'let focus=null;for(const [jobId,job] of {registry}){{'
        'if(typeof job.priority!=="string")throw Error("Invalid native focus priority");'
        'if(!focus||job.priority<focus.priority)focus={jobId,priority:job.priority}}'
        'return {render:s,waitingSinceMs:Date.parse(s.memoryWait?.waitingSinceIso),'
        'hasReadyRender:ready.length>0,focus:focus&&{...focus,hasReadyRender:'
        'ready.some(w=>w.jobId===focus.jobId&&w.priority===focus.priority)},'
        f'requestPriority:{registry}.get(request?.jobId)?.priority}}}});'
        f'{setter}({gate});'
        '__vfCustom.report("renderMemoryFairness",true)}catch(e){'
        '__vfCustom.report("renderMemoryFairness",false,String(e))}\n'
    )


def patch_node(text):
    if MARKER in text:
        return text
    gates = list(re.finditer(r'async function ([\w$]+)\(\{key:([\w$]+),opKey:([\w$]+)=null,quality:([\w$]+)=null,lane:([\w$]+),jobId:([\w$]+)=null\}=\{\}\)\{', text))
    setters = list(re.finditer(r'function ([\w$]+)\(([\w$]+)\)\{([\w$]+)=typeof \2=="function"\?\2:[\w$]+\}', text))
    checks = list(re.finditer(r'function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)=\2,([\w$]+)=[\w$]+\(\3\)\)\{let ([\w$]+)=([\w$]+)\(\2\),', text))
    pumps = list(re.finditer(r'async function [\w$]+\(([\w$]+)\)\{let ([\w$]+)=([\w$]+)\(\1\);if\(\2\.waiters\.length===0\)\{[^}]+\}let ([\w$]+)=([\w$]+)\(\1\);', text))
    priorities = list(re.finditer(r'function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\.get\(\2\)\?\.priority\?\?([\w$]+)\}', text))
    matches = [(gate, setter) for gate in gates for setter in setters
               if setter.group(1) + '(' + gate.group(1) + ')' in text]
    if len(matches) != 1 or len(checks) != 1 or len(pumps) != 1 or len(priorities) != 1:
        raise RuntimeError('Required render memory fairness fingerprints missing or ambiguous')
    gate, setter = matches[0]
    check, state, limit = checks[0].group(1), checks[0].group(8), pumps[0].group(5)
    if state != pumps[0].group(3) or not re.search(r'function ' + re.escape(state) + r'\(', text):
        raise RuntimeError('Required render memory fairness state boundary drifted')
    priority = priorities[0]
    if priority.group(1) + '(' + checks[0].group(3) + ')' not in checks[0].group(0):
        raise RuntimeError('Required render memory fairness priority boundary drifted')
    registry = priority.group(3)
    # Rebind both the native function and current callback: native initialization
    # may run before or after this hook, and must not restore an unwrapped gate.
    # v3: same getState contract via node/scheduler-hotpath.cjs, which skips the
    # per-waiter scan while a render is active and checks each admission key once.
    hook = (
        f'\n{MARKER};try{{{gate.group(1)}=__vfCustom.wrapRenderMemoryGate({gate.group(1)},'
        f'__vfCustom.createRenderFocusState({{pX:{state},XBe:(...a)=>{check}(...a),KBe:{limit},jp:{registry}}}));'
        f'{setter.group(1)}({gate.group(1)});'
        '__vfCustom.report("renderMemoryFairness",true)}catch(e){'
        '__vfCustom.report("renderMemoryFairness",false,String(e))}\n'
    )
    v2 = _v2_hook(gate.group(1), setter.group(1), state, check, limit, registry)
    if V2_MARKER in text:
        if text.count(V2_MARKER) != 1 or text.count(v2) != 1:
            raise RuntimeError('Required render memory fairness v2 hook boundary drifted')
        return text.replace(v2, hook, 1)
    if LEGACY_MARKER in text:
        legacy = (
            f'\n{LEGACY_MARKER};try{{{gate.group(1)}=__vfCustom.wrapRenderMemoryGate({gate.group(1)},()=>{{'
            f'const s={state}("render");return {{render:s,waitingSinceMs:Date.parse(s.memoryWait?.waitingSinceIso),'
            'hasReadyRender:s.waiters.some(w=>["frameshift","remotion"].includes(w.resourceKey)&&'
            f'{check}("render",w.jobId,{limit}("render"),w.resourceKey,w.priority)===null)}}}});'
            f'{setter.group(1)}({gate.group(1)});'
            '__vfCustom.report("renderMemoryFairness",true)}catch(e){'
            '__vfCustom.report("renderMemoryFairness",false,String(e))}\n'
        )
        if text.count(LEGACY_MARKER) != 1 or text.count(legacy) != 1:
            raise RuntimeError('Required render memory fairness legacy hook boundary drifted')
        return text.replace(legacy, hook, 1)
    return text + hook
