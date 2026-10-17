"""Keep the segment wordSyncVersion that the native resume check requires.

Native chunkRender writes provider_outputs_json through a fixed key allowlist that
omits wordSyncVersion, while the resume check demands wordSyncVersion === NAe for
text_overlay / composite_* / infographic_2d / custom_animation segments. Every
retry or restart therefore re-rendered all such segments, invalidated the smart
overlays of their neighbours and re-searched/re-rendered B-roll in those chunks.
The writer is only used for fresh renders of the current code, so the value is
the native one (O.wordSyncVersion, else the native constant).
"""
import re

MARKER = '/* vf-custom:segment-wordsync-v1 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required segment wordSync hook duplicated')
        return text
    writers = re.findall(r'provider_outputs_json:JSON\.stringify\(\{plannedType:([\w$]+)\.plannedType\|\|([\w$]+)\.type,', text)
    checks = re.findall(r'\|\|([\w$]+)\.wordSyncVersion===([\w$]+)\),[\w$]+=\1\.smartOverlay\|\|null', text)
    if len(writers) != 1 or len(checks) != 1 or writers[0][0] != checks[0][0]:
        raise RuntimeError('Required segment wordSync fingerprint missing or ambiguous')
    result, row = writers[0]
    constant = checks[0][1]
    old = f'provider_outputs_json:JSON.stringify({{plannedType:{result}.plannedType||{row}.type,'
    new = (f'provider_outputs_json:JSON.stringify({{{MARKER}wordSyncVersion:{result}.wordSyncVersion??{constant},'
           f'plannedType:{result}.plannedType||{row}.type,')
    return text.replace(old, new, 1)
