"""Home graphics renders do not consume a server Frameshift CPU slot.

A Frameshift render executing on the Home PC still holds its native licensed
render lease (cancellation/licensing unchanged). While it does, the native
Frameshift resource cap admits one additional SERVER render, so Home GPU adds
capacity instead of replacing a faster local render. The render lane gets the
matching extra slot through custom.mjs laneSize; RAM admission is unchanged.
"""
import re

MARKER = '/* vf-custom:home-graphics-capacity-v1 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required home graphics capacity hook duplicated')
        return text
    caps = re.findall(r'function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{return \2==="render"&&\4==="frameshift"\?'
                      r'Math\.min\(\3,([\w$]+)\(\)\):\3\}', text)
    if len(caps) != 1:
        raise RuntimeError('Required home graphics capacity fingerprint missing or ambiguous')
    cap, _, _, _, limit = caps[0]
    hook = (
        f'\n{MARKER};try{{const o={cap};{cap}=function(e,t,r){{return e==="render"&&r==="frameshift"?'
        f'Math.min(t,{limit}()+__vfCustom.homeRemoteActive("frameshift")):o.apply(this,arguments)}};'
        '__vfCustom.report("homeGraphicsCapacity",true)}catch(e){'
        '__vfCustom.report("homeGraphicsCapacity",false,String(e))}\n'
    )
    return text + hook
