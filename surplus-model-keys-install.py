"""Route Surplus DeepSeek calls (all attempts) through their own key (node/surplus-model-keys.cjs).

v1 hook: the Surplus chat request picks the key per model. Attempt hook: legs marked surplusKey
"configured" (the extra DeepSeek round custom.mjs inserts before the Luna fallback) keep the
configured key through an async scope around the native per-attempt call.
"""
import re

MARKER = '/* vf-custom:surplus-model-keys-v1 */'
ATTEMPT = '/* vf-custom:surplus-attempt-scope-v1 */'


def _attempt_hook(text):
    calls = re.findall(r'=>([\w$]+)\(\{spec:[\w$]+,messages:[\w$]+,opts:', text)
    if len(calls) != 1 or not re.search(r'async function ' + re.escape(calls[0]) + r'\(\{spec:', text):
        raise RuntimeError('LLM attempt function missing or ambiguous')
    name = calls[0]
    return (f'\n{ATTEMPT};try{{{name}=__vfSurplusKeys.wrapAttempt({name});'
            '__vfCustom.report("surplusAttemptScope",true)}catch(e){__vfCustom.report("surplusAttemptScope",false,String(e))}\n')


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1 or text.count('__vfSurplusKeys.wrapSurplusRequest(') != 1:
            raise RuntimeError('Surplus model key hook is incomplete or duplicated')
        if ATTEMPT in text:
            if text.count(ATTEMPT) != 1:
                raise RuntimeError('Surplus attempt scope hook duplicated')
            return text
        return text + _attempt_hook(text)
    sites = re.findall(r'([\w$]+)\(\{url:"https://api\.surplusintelligence\.ai/v1/chat/completions",apiKey:[\w$.]+,payload:[\w$]+,provider:"surplus"', text)
    if len(sites) != 1:
        raise RuntimeError('Surplus chat request call site missing or ambiguous')
    name = sites[0]
    if len(re.findall(r'function ' + re.escape(name) + r'\(\{url:[\w$]+,apiKey:[\w$]+,payload:[\w$]+,provider:[\w$]+', text)) != 1:
        raise RuntimeError('Surplus chat request function signature drifted')
    hook = (f'\n{MARKER};try{{{name}=__vfSurplusKeys.wrapSurplusRequest({name});globalThis.__vfSurplusModelKeys={name};'
            '__vfCustom.report("surplusModelKeys",true)}catch(e){__vfCustom.report("surplusModelKeys",false,String(e))}\n')
    return 'import __vfSurplusKeys from "./vf-custom/surplus-model-keys.cjs";\n' + text + hook + _attempt_hook(text)
