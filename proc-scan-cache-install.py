"""Feed the native render memory sampler a shared /proc snapshot (node/proc-scan-cache.cjs).

The native module keeps two test hooks: a process-table provider used by the scanner
(`function X(){if(T)return T();...}`) and a PSS reader (`function W(e){if(S)return S(e);...}`).
Their module init sets both to null; this patch sets them to the vf-custom providers.
"""
import re

MARKER = '/* vf-custom:proc-scan-cache-v1 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required proc scan hook duplicated')
        return text
    scan = re.findall(r'function [\w$]+\(\)\{if\(([\w$]+)\)return \1\(\);if\(process\.platform==="linux"\)\{let [\w$]+=[\w$]+\(\);if\([\w$]+\)return [\w$]+\}return [\w$]+\(\)\}', text)
    fas = re.findall(r'function [\w$]+\([\w$]+\)\{if\(([\w$]+)\)return \1\([\w$]+\);if\(([\w$]+)\|\|process\.platform!=="linux"\)return null;try\{let [\w$]+=[\w$]+\.readFileSync\(`/proc/\$\{[\w$]+\}/smaps_rollup`', text)
    if len(scan) != 1 or len(fas) != 1 or fas[0][1] != scan[0]:
        raise RuntimeError('Required proc scan fingerprint missing or ambiguous')
    table, reader = scan[0], fas[0][0]
    init = f'{table}=null,{reader}=null;'
    if text.count(init) != 1:
        raise RuntimeError('Required proc scan init missing or ambiguous')
    return text.replace(init, f'{table}=__vfCustom.procScanTable??null,{reader}=__vfCustom.procScanPss??null;{MARKER}', 1)
