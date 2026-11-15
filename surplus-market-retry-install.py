"""Restore bounded retries for known temporary Surplus marketplace 404s."""
import re

MARKER = 'vf-custom:surplus-market-retry-v1'


def patch_node(text):
    if MARKER in text:
        if text.count('__vfCustom.shouldStopSurplusRetry(') != 1:
            raise RuntimeError('Surplus retry marker has no unique call site')
        return text
    waits = list(re.finditer(r'__vfCustom\.retryDelay\(([\w$]+),([\w$]+)\(([\w$]+),', text))
    if len(waits) != 1:
        raise RuntimeError('Surplus retry delay call site missing or ambiguous')
    wait = waits[0]
    spec, _, err = wait.groups()
    window_start = max(0, wait.start() - 1200)
    window = text[window_start:wait.start()]
    pattern = re.compile(r'if\(([\w$]+)\|\|([\w$]+)\(' + re.escape(err) + r'\)\|\|!([\w$]+)\(' + re.escape(err) + r'\)\|\|([\w$]+)\)\{')
    matches = list(pattern.finditer(window))
    if len(matches) != 1:
        raise RuntimeError('Surplus native retry stop guard missing or ambiguous')
    match = matches[0]
    hard, no_retry, retryable, semantic_stop = match.groups()
    replacement = (f'if(/* {MARKER} */__vfCustom.shouldStopSurplusRetry('
                   f'{spec},{err},{hard},{retryable}({err}))||{no_retry}({err})||{semantic_stop}){{')
    start, end = window_start + match.start(), window_start + match.end()
    return text[:start] + replacement + text[end:]
