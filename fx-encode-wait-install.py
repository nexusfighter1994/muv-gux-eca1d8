"""Give the FX transition encoder time to finish under CPU load (2026-11-09).

fxtransitions/runner.py pipes the rendered window frames into ffmpeg (libx264 medium). x264 holds a short window
clip completely in its lookahead, so the encoding happens after stdin closes, and the runner then waits only 30 s:
  code = self.proc.wait(timeout=30)  ->  kill, RuntimeError('ffmpeg encode did not stop after its input closed')
VidForge reports "Cinematic transitions could not be baked ... the chunk keeps its hard cuts". On the saturated
server (load 100-160 on 16 cores) the flush takes longer: 15 chunks lost their transitions on 2026-11-09, 5 on 11-08.

The wait becomes 90 s. Output is unchanged. The runner is a fresh process per job, so the edit needs no restart, and
the caller's own budget (service.py: max(120 s, 3 s per window frame)) still bounds the whole job.
"""
import ast
import re

MARKER = '# vf-custom:fx-encode-wait-v1'
WAIT_SECONDS = 90
NEW_LINE_TAIL = f'timeout={WAIT_SECONDS})  {MARKER} (native 30)'

PATTERN = re.compile(
    r"(?P<head>\n(?P<i>[ ]+)try:\n(?P=i)    code = self\.proc\.wait\()timeout=30\)(?P<tail>\n"
    r"(?P=i)except subprocess\.TimeoutExpired:\n"
    r"(?P=i)    self\.proc\.kill\(\)\n"
    r"(?P=i)    self\.proc\.wait\(\)\n"
    r"(?P=i)    raise RuntimeError\('ffmpeg encode did not stop after its input closed'\)\n)")


def patch_runner(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('FX encode wait marker duplicated')
        return text
    sites = list(PATTERN.finditer(text))
    if len(sites) != 1:
        raise RuntimeError(f'Native FX encode wait site missing or ambiguous ({len(sites)})')
    m = sites[0]
    result = text[:m.start()] + m.group('head') + NEW_LINE_TAIL + m.group('tail') + text[m.end():]
    if result.count(MARKER) != 1 or result.replace(NEW_LINE_TAIL, 'timeout=30)') != text:
        raise RuntimeError('FX encode wait patch verification failed')
    ast.parse(result)
    return result
