"""Admit app_budget refusals while real free RAM stays above a floor (node/real-headroom-gate.cjs).

Wraps the current scheduler memory gate AFTER render fairness, so render_fair_turn,
pressure and live_headroom refusals stay native. Exposes the gate as globalThis.__vfRealHeadroom.
"""
import re

MARKER = '/* vf-custom:real-headroom-v1 */'
FAIRNESS = '/* vf-custom:render-memory-fairness-k3 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1 or text.count('__vfHeadroom.createRealHeadroomGate(') != 1:
            raise RuntimeError('Real headroom hook is incomplete or duplicated')
        return text
    if text.count(FAIRNESS) != 1:
        raise RuntimeError('Real headroom requires exactly one render fairness hook before it')
    fairness = re.search(re.escape(FAIRNESS) + r';try\{([\w$]+)=__vfCustom\.wrapRenderMemoryGate\(\1,.*?\);([\w$]+)\(\1\);', text)
    if not fairness:
        raise RuntimeError('Render fairness gate/setter boundary drifted')
    gate, setter = fairness.group(1), fairness.group(2)
    if not re.search(r'function ' + re.escape(setter) + r'\(([\w$]+)\)\{[\w$]+=typeof \1=="function"\?\1:[\w$]+\}', text):
        raise RuntimeError('Native memory gate setter drifted')
    hook = (f'\n{MARKER};try{{{gate}=__vfHeadroom.createRealHeadroomGate({gate});{setter}({gate});'
            f'globalThis.__vfRealHeadroom={gate};__vfCustom.report("realHeadroomGate",true)}}catch(e){{'
            '__vfCustom.report("realHeadroomGate",false,String(e))}\n')
    return 'import __vfHeadroom from "./vf-custom/real-headroom-gate.cjs";\n' + text + hook
