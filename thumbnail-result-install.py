"""Guard native thumbnail persistence; no app imports or provider changes."""
import re

MARKER = '/* vf-custom:thumbnail-result-guard-v1 */'


def patch_node(text):
    anchor = text.find('"Fetching reference thumbnail"')
    start = text.rfind('async function ', 0, anchor)
    end = text.find('async function ', start + 15)
    if anchor < 0 or start < 0 or end < 0:
        raise RuntimeError('Native thumbnail orchestration fingerprint missing')
    body = text[start:end]
    pattern = re.compile(
        r'if\((?P<persist>[\w$]+)\)\{let (?P<items>[\w$]+)=JSON\.parse\('
        r'(?P<db>[\w$]+)\.prepare\("SELECT thumbnails_json FROM pipeline_jobs WHERE job_id=\?"\)'
        r'\.get\((?P<job>[\w$]+)\)\?\.thumbnails_json\|\|"\[\]"\);'
        r'(?P<save>[\w$]+)\((?P=db),(?P=job),\[\.\.\.(?P=items)\.filter\('
        r'(?P<item>[\w$]+)=>(?P=item)\.path!==(?P<result>[\w$]+)\.path\),'
        r'(?P=result)\],(?P<now>[\w$]+)\(\)\),(?P<update>[\w$]+)\('
        r'\{thumbnail_path:(?P=result)\.path\}\)\}return (?P=result)'
    )
    guarded = re.compile(
        re.escape(MARKER) + r'if\(typeof (?P<value>[\w$]+)\?\.path!=="string"\|\|!'
        r'(?P=value)\.path\.trim\(\)\)return null;'
    )
    if MARKER in text:
        if text.count(MARKER) != 1 or len(guarded.findall(body)) != 1 or 'typeof ' not in body or '?.path==="string"' not in body:
            raise RuntimeError('Incomplete or duplicate thumbnail result guard')
        return text
    matches = list(pattern.finditer(body))
    if len(matches) != 1:
        raise RuntimeError(f'Native thumbnail persistence fingerprint count: {len(matches)}')
    match = matches[0]
    result, item = match['result'], match['item']
    original = match.group(0)
    safe = original.replace(
        f'{item}=>{item}.path!=={result}.path',
        f'{item}=>typeof {item}?.path==="string"&&{item}.path.trim()&&{item}.path!=={result}.path',
    )
    guard = f'{MARKER}if(typeof {result}?.path!=="string"||!{result}.path.trim())return null;'
    changed = body[:match.start()] + guard + safe + body[match.end():]
    return text[:start] + changed + text[end:]
