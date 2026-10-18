"""Give pipeline-blocking short FFmpeg steps the scheduler's interactive priority (node/op-priority.cjs).

Finds the native scheduler at the voiceover cut (`X.run(t,"ffmpeg",()=>CUT({source:…,prepared:!0,
targetPath:…,startTime:….start_time,endTime:….end_time…`) and appends a hook that wraps X.run.
"""
import re

MARKER = '/* vf-custom:op-priority-v1 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required op priority hook duplicated')
        return text
    found = set(re.findall(r'([\w$]+)\.run\([\w$]+,"ffmpeg",\(\)=>[\w$]+\(\{source:[\w$]+,prepared:!0,targetPath:[\w$]+,'
                           r'startTime:[\w$]+\.start_time,endTime:[\w$]+\.end_time', text))
    if len(found) != 1:
        raise RuntimeError('Required voiceover cut fingerprint missing or ambiguous')
    name = found.pop()
    hook = ('process.getBuiltinModule("module").createRequire(import.meta.url)("./vf-custom/op-priority.cjs")'
            '.installOpPriority(()=>' + name + ')')
    return text + '\n' + MARKER + ';try{' + hook + '}catch{}\n'
