"""Raise the native default FFmpeg/ffprobe process timeout from 120 s to 360 s (2026-11-10).

The native spawn helper kills every FFmpeg call that passes no timeout of its own after 120 s:
  function Z_t(e,t,{timeoutMs:r=J_t,...}) ... setTimeout(()=>{c.kill("SIGKILL"),a(new Wge(e,r,...))},r)
  dJ="FFMPEG_TIMEOUT",P$=3e4,J_t=12e4
On the saturated server (load 100-180 on 16 cores) healthy calls need longer, so work is thrown away instead of
finishing: "Overlay layers could not be composited (ffmpeg timed out after 120000ms ...)" 2-6 times per hour and
the voiceover cleanup of long scripts (tts step: af914bb5, 813cce12 five times until it failed for good, 5d35cd3e
after 43 min of work on 2026-11-09). The message "the process stopped making progress" is only the default text.

Only the default changes; calls with their own timeout keep it. A truly hung process is killed 4 minutes later.
"""
import re

MARKER = '/* vf-custom:ffmpeg-default-timeout-v1 */'
NEW_VALUE = '36e4'

PATTERN = re.compile(r'(?P<head>[\w$]+="FFMPEG_TIMEOUT",[\w$]+=3e4,(?P<name>[\w$]+)=)12e4(?P<tail>,)')


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('FFmpeg default timeout marker duplicated')
        return text
    sites = list(PATTERN.finditer(text))
    if len(sites) != 1:
        raise RuntimeError(f'Native FFmpeg default timeout site missing or ambiguous ({len(sites)})')
    m = sites[0]
    name = re.escape(m.group('name'))
    defaults = re.findall(r'\{timeoutMs:[\w$]+=' + name + r',', text)
    if len(defaults) != 1:
        raise RuntimeError(f'Native FFmpeg spawn default not unique ({len(defaults)})')
    result = text[:m.start()] + m.group('head') + MARKER + NEW_VALUE + m.group('tail') + text[m.end():]
    if result.count(MARKER) != 1 or result.replace(MARKER + NEW_VALUE, '12e4') != text:
        raise RuntimeError('FFmpeg default timeout patch verification failed')
    return result
