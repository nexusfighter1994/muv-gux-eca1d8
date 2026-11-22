"""Leaderboard statistics cache 10 min -> 3 h (2026-11-17).

perf over one API freeze (21:26:07-21:27:16Z, 69 s): 99 % of the main thread in the leaderboard stats builder
(lNe -> j3o): five synchronous better-sqlite3 queries over usage_records (4.0 M rows since the owner joined the
leaderboard on 2026-10-08) through the ts index with a table lookup per row, plus a LIKE 'ebook:%' full scan.
A 30-s timer recomputes once the 10-min cache expires, so the API froze for 60-80 s about every 11 min and the
Home PC ran dry each time. The cache now lasts 3 h; completed videos still mark the stats dirty (fresh XP).
Owner rule: observe, intervene on notable blockers; hot change done 21:30:57Z, this keeps it after a rebuild.
"""
import re

MARKER = '/* vf-custom:leaderboard-cache-v1 */'
PATTERN = r'([\w$]+)=10\*6e4,([\w$]+)=\["videos","minutes","best_day_videos"'
# 2026-11-18: every completed video marks the stats dirty and forced the same 60-70 s rebuild; the freeze at
# 05:06:48Z made six RunPod render polls time out at once and the pod lost its render service. Floor: a dirty
# cache younger than 3 h is still served (fresh:true callers still rebuild). v1 used 30 min; 09:18Z a completion
# still cost a 64-s freeze 30 min later, so the floor now equals the cache lifetime.
FLOOR_MARKER = '/* vf-custom:leaderboard-dirty-floor-v1 */'
FLOOR_MS = '108e5'
FLOOR_PATTERN = (r'async function ([\w$]+)\(\{fresh:([\w$]+)=!1\}=\{\}\)\{'
                 r'if\(!\2&&!([\w$]+)&&([\w$]+)&&Date\.now\(\)-\4\.at<([\w$]+)\)return \4\.value;')


def _cache(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('leaderboard cache hook duplicated')
        return text
    found = re.findall(PATTERN, text)
    if len(found) != 1:
        raise RuntimeError(f'leaderboard cache fingerprint missing or ambiguous ({len(found)})')
    name = found[0][0]
    old = f'{name}=10*6e4,'
    at = text.index(old + found[0][1] + '=["videos","minutes","best_day_videos"')
    return text[:at] + f'{name}={MARKER}180*6e4,' + text[at + len(old):]


def _floor(text):
    if FLOOR_MARKER in text:
        if text.count(FLOOR_MARKER) != 1:
            raise RuntimeError('leaderboard dirty floor duplicated')
        # upgrade a bundle patched with the 30-min v1 floor
        old = re.escape(FLOOR_MARKER) + r'(if\(![\w$]+&&[\w$]+&&Date\.now\(\)-[\w$]+\.at<)18e5\)'
        return re.sub(old, lambda m: FLOOR_MARKER + m.group(1) + FLOOR_MS + ')', text, count=1)
    found = list(re.finditer(FLOOR_PATTERN, text))
    if len(found) != 1:
        raise RuntimeError(f'leaderboard dirty floor fingerprint missing or ambiguous ({len(found)})')
    m = found[0]
    fresh, cache = m.group(2), m.group(4)
    head = text.index('{', text.index('}={})', m.start()) + 4) + 1
    guard = f'{FLOOR_MARKER}if(!{fresh}&&{cache}&&Date.now()-{cache}.at<{FLOOR_MS})return {cache}.value;'
    return text[:head] + guard + text[head:]


def patch_node(text):
    return _floor(_cache(text))


if __name__ == '__main__':
    import sys
    src = open(sys.argv[1], encoding='utf-8').read()
    out = patch_node(src)
    print('changed' if out != src else 'unchanged', len(out) - len(src), 'bytes')
    if len(sys.argv) > 2:
        open(sys.argv[2], 'w', encoding='utf-8', newline='').write(out)
        print('written', sys.argv[2])
