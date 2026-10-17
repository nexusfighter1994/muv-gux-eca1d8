"""Keep rendered B-roll video segments on retry/restart.

Native o0s reuse check E() hashes the b_roll_video final_video input without the
`verify` (footage text check, on by default) and `window`/`slow` fields that uBn
really adds, so every rendered B-roll video looked stale on resume. The segment was
rendered again and, because its selected_source input carries the whole segment DB
row (bookkeeping columns change on every attempt), the stored pick was deleted and
the B-roll searched and downloaded again (>50% of a video's segments on a retry).

1. E() also accepts the exact inputs uBn builds for the same pick
   (__vfCustom.brollFinalReuse, node/broll-reuse.cjs).
2. selected_source inputs (b_roll_video, composite_video) hash the planned segment
   content without the volatile bookkeeping columns (__vfCustom.stableSegmentInput).
"""
import re

MARKER = '/* vf-custom:broll-reuse-v1 */'
STABLE = '/* vf-custom:broll-stable-input-v1 */'


def _one(pattern, text, what):
    found = list(re.finditer(pattern, text))
    if len(found) != 1:
        raise RuntimeError(f'Required B-roll reuse fingerprint missing or ambiguous: {what} ({len(found)})')
    return found[0]


def _reuse(text):
    head = _one(r"async function ([\w$]+)\(\{job:[\w$]+,slug:[\w$]+,chunkNumber:[\w$]+,segment:[\w$]+,videoBrief:[\w$]+,"
                r"language:[\w$]+,usedBroll:[\w$]+,brollClaims:[\w$]+,generationSnapshot:[\w$]+=null,outputPath:[\w$]+=null,"
                r"deps:[\w$]+=\{\}\}=\{\}\)\{if\(![\w$]+\)throw new Error\('brollVideo\.renderSegment", text, 'uBn')
    render = head.group(1)
    body = text[head.start():head.start() + 30000]
    fit = _one(r'let [\w$]+=([\w$]+)\([\w$]+,[\w$]+,\{allowSlow:[\w$]+\}\),[\w$]+=![\w$]+&&Array\.isArray', body, 'fit plan').group(1)
    verify = _one(r'\?\{verify:([\w$]+)\}:\{\}', body, 'verify flag').group(1)
    init = _one(r',([\w$]+)=[\w$]+\(\(\)=>\{[^\n]{0,600}?[\w$]+=\{renderSegment:' + re.escape(render) + r'\}\}\)', text, 'b-roll module init').group(1)
    check = _one(r'([\w$]+)=([\w$]+)==="b_roll_image"\?[\w$]+\(\{selected:([\w$]+),durationSec:([\w$]+),targetPath:([\w$]+),'
                 r'creditAuthor:([\w$]+),[^;]{0,200}?\):\{best:\3,durationSec:\4,outputPath:\5,creditAuthor:\6\};'
                 r'if\(([\w$]+)\.input_hash===([\w$]+)\(\1\)\)return!0;', text, 'E final hash check')
    k, ns, best, duration, path, credit, row, gm = check.groups()
    old = f'if({row}.input_hash==={gm}({k}))return!0;'
    new = (f'if({row}.input_hash==={gm}({k})||{MARKER}{ns}==="b_roll_video"&&__vfCustom.brollFinalReuse?.({{hash:{row}.input_hash,'
           f'GM:{gm},best:{best},durationSec:{duration},outputPath:{path},creditAuthor:{credit},outputJson:{row}.output_json,'
           f'fit:(__vfA,__vfB,__vfC)=>({init}(),{fit}(__vfA,__vfB,{{allowSlow:__vfC}})),verify:({init}(),{verify})}}))return!0;')
    at = check.end() - len(old)
    return text[:at] + new + text[check.end():]


def _stable(text):
    head = _one(r"async function [\w$]+\(\{job:[\w$]+,slug:[\w$]+,chunkNumber:[\w$]+,segment:[\w$]+,videoBrief:[\w$]+,"
                r"language:[\w$]+,usedBroll:[\w$]+,brollClaims:[\w$]+,generationSnapshot:[\w$]+=null,outputPath:[\w$]+=null,"
                r"deps:[\w$]+=\{\}\}=\{\}\)\{if\(![\w$]+\)throw new Error\('brollVideo\.renderSegment", text, 'uBn')
    start = head.start()
    body = text[start:start + 30000]
    rest = _one(r'\{revision_no:[\w$]+,selected_revision_id:[\w$]+,\.\.\.([\w$]+)\}=[\w$]+', body, 'b-roll segment rest').group(1)
    pick = _one(r'[\w$]+=\{segment:' + re.escape(rest) + r',videoBrief:', body, 'b-roll selected_source input')
    at = start + pick.start() + pick.group(0).index('{segment:') + len('{segment:')
    text = text[:at] + f'{STABLE}(__vfCustom.stableSegmentInput?.({rest})??{rest})' + text[at + len(rest):]
    comp = _one(r'operation:"selected_source",operationOrder:[\w$]+,input:\{segment:([\w$]+),videoBrief:[\w$]+,language:[\w$]+,'
                r'\.\.\.[\w$]+\?\{footageTopic:[\w$]+\}:\{\},\.\.\.[\w$]+\?\{translationPin:[\w$]+\}:\{\}\}', text, 'composite_video selected_source input')
    seg = comp.group(1)
    at = comp.start() + comp.group(0).index('{segment:') + len('{segment:')
    return text[:at] + f'(__vfCustom.stableSegmentInput?.({seg})??{seg})' + text[at + len(seg):]


def patch_node(text):
    if MARKER in text or STABLE in text:
        if text.count(MARKER) != 1 or text.count(STABLE) != 1:
            raise RuntimeError('Required B-roll reuse hook duplicated or partial')
        return text
    return _stable(_reuse(text))
