"""Bake chunk FX transitions GOP-wise instead of re-encoding the whole chunk (node/fx-smart-bake.cjs, 2026-11-09).

Native chunk_fx (ZUn) runs one full encode:
  await a("ffmpeg",()=>l(vPs({basePath:t,clipPath:g,pieces:I,totalFrames:C,width:S.width,height:S.height,
                              encodeArgs:T,outPath:b}),{signal:f,timeoutMs:JUn}))
The patch routes that single call through bakeChunk(), which keeps the same lane, signal and timeout and falls back
to exactly this native encode. The native post-checks (frame count, stream contract, audio packets) stay in force.
"""
import re

MARKER = '/* vf-custom:fx-smart-bake-v1 */'

PATTERN = re.compile(
    r'await (?P<lane>[\w$]+)\("ffmpeg",\(\)=>(?P<run>[\w$]+)\((?P<build>[\w$]+)\('
    r'(?P<args>\{basePath:[\w$]+,clipPath:[\w$]+,pieces:[\w$]+,totalFrames:[\w$]+,'
    r'width:[\w$]+\.width,height:[\w$]+\.height,encodeArgs:[\w$]+,outPath:[\w$]+\})\),'
    r'(?P<options>\{signal:[\w$]+,timeoutMs:[\w$]+\})\)\)')


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('FX smart bake marker duplicated')
        return text
    sites = list(PATTERN.finditer(text))
    if len(sites) != 1:
        raise RuntimeError(f'Native chunk FX encode site missing or ambiguous ({len(sites)})')
    m = sites[0]
    new = (f'await {m.group("lane")}("ffmpeg",()=>{MARKER}'
           'process.getBuiltinModule("module").createRequire(import.meta.url)("./vf-custom/fx-smart-bake.cjs")'
           f'.bakeChunk({{buildFullArgs:{m.group("build")},args:{m.group("args")},'
           f'ffmpeg:{m.group("run")},options:{m.group("options")}}}))')
    result = text[:m.start()] + new + text[m.end():]
    if result.count(MARKER) != 1:
        raise RuntimeError('FX smart bake patch verification failed')
    return result
