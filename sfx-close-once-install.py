"""Close the native SFX stem file descriptor exactly once (crash fix 2026-11-08).

The native SFX mixer (finalAssembly "Placing the sound effects") does
  d=fs.openSync(stem,"w"); try{ ...writeSync(d)...; return fs.closeSync(d), await ffmpeg(...), ... }
  finally{ try{fs.closeSync(d)}catch{} ... }
so after the ffmpeg encode (seconds to minutes later) it closes the same fd number a second time.
By then the number belongs to someone else (usually a socket), which gets closed behind libuv's
back; libuv later re-arms that fd and aborts with "uv__io_poll: Assertion errno == EEXIST" (exit -6).
Proven by the vf-epoll tracer on 08.11. (11:38Z hit, 14:31Z + 15:00Z aborts during 72517a5e SFX).

Patch: the first close forgets the fd (d=-1) before closing it; the finally only closes a still-open fd.
Behaviour is otherwise identical (stem written, ffmpeg encode, rename, cleanup).
"""
import re

MARKER = '/* vf-custom:sfx-close-once-v1 */'

PATTERN = re.compile(
    r'(?P<fd>[\w$]+)=(?P<fs>[\w$]+)\.openSync\((?P<stem>[\w$]+),"w"\);'
    r'try\{let (?P<plan>[\w$]+)=(?P<mix>[\w$]+)\(\{placements:[\w$]+,sounds:[\w$]+,totalSec:[\w$]+,write:[\w$]+=>(?P=fs)\.writeSync\((?P=fd),'
    r'(?P<write>[^;]{0,200}?)\}\);'
    r'return (?P=fs)\.closeSync\((?P=fd)\),await (?P<run>[\w$]+)\(\["-f","s16le",'
    r'(?P<rest>.{0,700}?)'
    r'\}finally\{try\{(?P=fs)\.closeSync\((?P=fd)\)\}catch\{\}')


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('SFX close-once marker duplicated')
        return text
    sites = list(PATTERN.finditer(text))
    if len(sites) != 1:
        raise RuntimeError(f'Native SFX stem close site missing or ambiguous ({len(sites)})')
    m = sites[0]
    fd, fs = m.group('fd'), m.group('fs')
    old = m.group(0)
    new = old.replace(
        f'return {fs}.closeSync({fd}),await {m.group("run")}(["-f","s16le",',
        f'return {MARKER}(()=>{{const vfFd={fd};{fd}=-1;{fs}.closeSync(vfFd)}})(),await {m.group("run")}(["-f","s16le",', 1)
    new = new.replace(
        f'}}finally{{try{{{fs}.closeSync({fd})}}catch{{}}',
        f'}}finally{{try{{{fd}>=0&&{fs}.closeSync({fd})}}catch{{}}', 1)
    if new == old or new.count(MARKER) != 1 or f'{fd}>=0&&{fs}.closeSync({fd})' not in new:
        raise RuntimeError('SFX close-once rewrite failed')
    return text[:m.start()] + new + text[m.end():]
