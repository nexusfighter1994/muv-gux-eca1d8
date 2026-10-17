"""Short-lived cache for the native Frameshift concurrency limit.

The native scheduler reads this limit from the SQLite 'general' settings row on
EVERY admission check, once per waiting render. With hundreds of Frameshift
waiters that saturated the main event loop (2026-10-16 profile: 61% CPU), so
internal HTTP calls such as the Home fallback permit timed out. Value and
validation stay native; native settings writers invalidate the cache at once.
"""
import re

MARKER = '/* vf-custom:frameshift-limit-cache-v1 */'
TTL_MS = 1000


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required frameshift limit cache hook duplicated')
        return text
    limits = re.findall(r'function ([\w$]+)\(\)\{return [\w$]+\([\w$]+\(\)\.frameshiftConcurrencyLimit\)\}', text)
    writers = re.findall(r"function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\(\);[\w$]+\.prepare\(`INSERT INTO app_settings "
                         r"\(key, value_json\) VALUES \('general', @value\)", text)
    if len(limits) != 1 or not writers or len(set(writers)) != len(writers):
        raise RuntimeError('Required frameshift limit cache fingerprints missing or ambiguous')
    limit = limits[0]
    wraps = ''.join(f'{w}=(o=>function(){{c=null;try{{return o.apply(this,arguments)}}finally{{c=null}}}})({w});'
                    for w in writers)
    hook = (
        f'\n{MARKER};try{{let c=null;const o={limit},s=globalThis.__vfFrameshiftLimitCache={{hits:0,misses:0}};'
        f'{limit}=function(){{const n=Date.now();if(c!==null&&n>=c.at&&n-c.at<{TTL_MS}){{s.hits++;return c.value}}'
        'const v=o.apply(this,arguments);c={at:n,value:v};s.misses++;return v};'
        f'{wraps}'
        '__vfCustom.report("frameshiftLimitCache",true)}catch(e){'
        '__vfCustom.report("frameshiftLimitCache",false,String(e))}\n'
    )
    return text + hook
