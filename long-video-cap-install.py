"""Long-video cap (2026-11-18): at most N long videos run at once, short ones keep the free slots.

Owner: "Sollten wir nun bei den langen videos auf 5 reduzieren die zugleich rendern?" -> "Mach das bitte".
Logic in node/long-video-cap.cjs; this installer appends one tail hook that hands the module the queue database
handle and the queue dispatcher. Hot knob: /data/runtime/vf-long-video-cap.json.
"""
import re

MARKER = '/* vf-custom:long-video-cap-v1 */'


def _one(pattern, text, what):
    found = re.findall(pattern, text)
    if len(found) != 1:
        raise RuntimeError(f'long-video cap fingerprint missing or ambiguous ({len(found)}): {what}')
    return found[0]


def names(text):
    return {
        'db': _one(r'([\w$]+)\.prepare\("UPDATE queue_jobs SET status = \'paused\', updated_at = \? WHERE status = \'pausing\'"\)', text, 'queue db handle'),
        'dispatch': _one(r'async function ([\w$]+)\(\)\{try\{if\([\w$]+\(\)\.paused\)return null;let\{authorizeCapability:', text, 'queue dispatcher'),
    }


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('long-video cap hook duplicated')
        return text
    n = names(text)
    hook = (f'\n{MARKER};(()=>{{try{{__vfCustom.installLongVideoCap({{db:()=>{n["db"]},dispatch:()=>{n["dispatch"]}()}});'
            '__vfCustom.report("longVideoCap",true)}catch(e){__vfCustom.report("longVideoCap",false,String(e))}})();\n')
    return text + hook


if __name__ == '__main__':
    import sys
    src = open(sys.argv[1], encoding='utf-8').read()
    print(names(src))
    if len(sys.argv) > 2:
        out = patch_node(src)
        open(sys.argv[2], 'w', encoding='utf-8', newline='').write(out)
        print('written', sys.argv[2], len(out) - len(src), 'bytes added')
