"""Allow the exact Surplus Vision model validated by the 2026-11-04 comparison."""

ORIGINAL = r'''function $1t(e){let t=String(e||"").toLowerCase().split("/").at(-1);return/(?:tts|audio|transcrib|image|embedding|search|moderation)/.test(t)||/^o(?:1|3)-(?:mini|preview)(?:-|$)/.test(t)?!1:/^(?:gpt-(?:4o|4\.1|[56](?:\.\d+)?)(?:[.\-]|$)|o[134](?:-|$)|gemini-(?:1\.5|2|3)|claude-(?:3|sonnet|opus|haiku))/.test(t)}'''
PATCHED = ORIGINAL.replace('?!1:/^', '?!1:t==="deepseek-v4.1-flash"||/^')


def patch_node(source):
    old, new = source.count(ORIGINAL), source.count(PATCHED)
    if (old, new) == (0, 1):
        return source
    if (old, new) != (1, 0):
        raise RuntimeError('Vision model capability predicate is missing, changed or ambiguous')
    return source.replace(ORIGINAL, PATCHED, 1)
