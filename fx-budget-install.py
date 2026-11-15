"""Give slow FX transition renders a wall-clock budget that fits the loaded server (2026-11-10).

fxtransitions/service.py bounds the whole FX job (runner child process) with
  max(120.0, frames * 3.0)  seconds, frames = sum of the window lengths.
On the saturated server (load 75-140 on 16 cores) working renders run into that bound: over 2026-11-09/10 the
2,460 completed bakes took p50 31 s, p90 66 s, p99 110 s, max 156 s (24 above 110 s), and 10 jobs died right at
their budget (121.7 ... 187.0 s) with FX_TRANSITIONS_TIMEOUT. VidForge then reports
"Cinematic transitions could not be baked ... the chunk keeps its hard cuts".

The budget becomes max(360.0, frames * 6.0): never below the native one, well under VidForge's own 900 s poll
timeout for the job (JUn). Output is unchanged. FFLOW_FX_TIMEOUT_SECONDS still overrides it.
service.py lives in the long-running FFlow workers, so the edit only reaches workers started after it.
"""
import ast

MARKER = '# vf-custom:fx-budget-v1'
NATIVE_LINE = '    return max(120.0, frames * 3.0)\n'
NEW_LINE = f'    return max(360.0, frames * 6.0)  {MARKER} (native max(120.0, frames * 3.0))\n'
ANCHOR = 'def fx_timeout_seconds(windows) -> float:\n'


def patch_service(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('FX budget marker duplicated')
        return text
    if text.count(ANCHOR) != 1 or text.count(NATIVE_LINE) != 1 or text.index(NATIVE_LINE) < text.index(ANCHOR):
        raise RuntimeError('Native FX budget site missing or ambiguous')
    body = text[text.index(ANCHOR):text.index(NATIVE_LINE)]
    if '\ndef ' in body or '\nasync def ' in body or '\nclass ' in body:
        raise RuntimeError('Native FX budget site missing or ambiguous')
    result = text.replace(NATIVE_LINE, NEW_LINE)
    if result.count(MARKER) != 1 or result.replace(NEW_LINE, NATIVE_LINE) != text:
        raise RuntimeError('FX budget patch verification failed')
    ast.parse(result)
    return result
