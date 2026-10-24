"""Expose the native render RAM allocation table to vf-custom (node/home-graphics/remote-active.cjs).

The native RAM gate keeps one entry per granted lease in a module Map
(`X.set(id,{laneKey,resourceKey,estimateMb,grantedAtMs})`). A Frameshift render that
executes on the Home PC still holds its full server estimate, so other lanes wait for
phantom memory. This patch publishes the Map as globalThis.__vfRamAllocations; while a
render runs remote, remote-active lowers that render's estimate and restores Ke after.
"""
import re

MARKER = '/* vf-custom:ram-allocations-v1 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required RAM allocations hook duplicated')
        return text
    found = re.findall(r'([\w$]+)\.set\([\w$]+,\{laneKey:[\w$]+,resourceKey:[\w$]+,estimateMb:[\w$]+,grantedAtMs:[\w$]+\(\)\}\)', text)
    if len(found) != 1:
        raise RuntimeError('Required RAM allocation fingerprint missing or ambiguous')
    table = found[0]
    if len(re.findall(r'\b' + re.escape(table) + r'=new Map\b', text)) != 1:
        raise RuntimeError('Required RAM allocation table declaration missing or ambiguous')
    # A getter: the table is assigned inside a lazy module init that may run after this tail.
    hook = ('Object.defineProperty(globalThis,"__vfRamAllocations",'
            '{configurable:true,get(){return ' + table + '}})')
    return text + '\n' + MARKER + ';try{' + hook + '}catch{}\n'
