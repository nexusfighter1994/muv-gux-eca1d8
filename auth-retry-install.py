"""Render-authorization retry (2026-11-20): a segment waits and is dispatched again when the app's own render
authorization is temporarily unavailable, instead of being aborted for the whole run.

Owner: "Repariere das problem! Und schau das das nie wieder passiert". On 20.11. 09:03-09:06Z (and on 06.11.,
12.11.) the authorization was unavailable for about three minutes; segments dispatched in that window were
left "rendering" with nothing queued until the complete chunkRender step had ended (8fe24646 stopped at
1606/1613, 782c9e14 lost 404 segments). Logic in node/auth-retry.cjs. This installer wraps the one binding the
chunk renderer calls for a segment; nothing about the authorization itself is touched.
Hot knob: /data/runtime/vf-auth-retry.json.
"""
import re

MARKER = '/* vf-custom:auth-retry-v1 */'


def _one(pattern, text, what):
    found = re.findall(pattern, text)
    if len(found) != 1:
        raise RuntimeError(f'auth retry fingerprint missing or ambiguous ({len(found)}): {what}')
    return found[0]


def names(text):
    dispatch, source = _one(r'\(\{dispatchSegment:([\w$]+)\}=([\w$]+)\)', text, 'segment dispatcher binding')
    # The chunk renderer must really call that binding for a segment.
    if len(re.findall(r'await ' + re.escape(dispatch) + r'\(\{job:', text)) != 1:
        raise RuntimeError('auth retry fingerprint missing or ambiguous: segment dispatch call')
    scheduler = _one(r'if\(([\w$]+)\.isJobAborted\(e\)\)\{let l=new Error\("Render job stopped"\)', text, 'scheduler')
    return {'dispatch': dispatch, 'source': source, 'scheduler': scheduler}


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('auth retry hook duplicated')
        return text
    n = names(text)
    anchor = '({dispatchSegment:%s}=%s)' % (n['dispatch'], n['source'])
    hook = (f';{MARKER}try{{{n["dispatch"]}=__vfCustom.wrapDispatchAuthRetry({n["dispatch"]},'
            f'{{isAborted:e=>{n["scheduler"]}.isJobAborted(e)}});__vfCustom.report("authRetry",true)}}'
            'catch(e){__vfCustom.report("authRetry",false,String(e))}')
    return text.replace(anchor, anchor + hook, 1)


if __name__ == '__main__':
    import sys
    src = open(sys.argv[1], encoding='utf-8').read()
    print(names(src))
    if len(sys.argv) > 2:
        out = patch_node(src)
        open(sys.argv[2], 'w', encoding='utf-8', newline='').write(out)
        print('written', sys.argv[2], len(out) - len(src), 'bytes added')
