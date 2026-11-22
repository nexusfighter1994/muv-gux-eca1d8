"""Oversize chunk split (2026-11-22): a chunk with more clips than FFlow accepts is composed in parts and joined.

Owner: "was scheitert da? FIXE ES!" 43a0317f (185 chunks) failed twice at its last chunk with
"fflow POST /v1/render: HTTP 422": the alignment had left 889.9 s of narration in chunk 185, the planner filled it
with 216 b-roll segments, and FFlow's CompositionRequest rejects more than 100 segment entries. The app requeues the
video by itself, so it looped. Logic in node/oversize-chunk.cjs. This installer appends one tail hook that wraps the
chunk base renderer; chunks up to `splitAbove` clips take the native path unchanged.
Hot knob: /data/runtime/vf-oversize-chunk.json {"enabled", "splitAbove", "partSegments"}.
"""
import re

MARKER = '/* vf-custom:oversize-chunk-v1 */'
W = r'[\w$]+'


def _one(pattern, text, what):
    found = re.findall(pattern, text)
    if len(found) != 1:
        raise RuntimeError(f'oversize chunk fingerprint missing or ambiguous ({len(found)}): {what}')
    return found[0]


def names(text):
    head = re.compile(
        r'async function (' + W + r')\(\{jobId:' + W + ',slug:' + W + ',chunkNumber:' + W + ',row:' + W
        + ',segmentResults:' + W + ',transitions:' + W + ',motionBlur:' + W + ',deps:' + W + ',checkpoint:' + W
        + ',polish:' + W + '=null,outputQuality:' + W + r'=null\}\)\{')
    found = list(head.finditer(text))
    if len(found) != 1:
        raise RuntimeError(f'oversize chunk fingerprint missing or ambiguous ({len(found)}): chunk base renderer')
    render = found[0].group(1)
    body = text[found[0].end():found[0].end() + 4000]
    end = re.search(r'\}(?:async )?function ', body)
    if not end:
        raise RuntimeError('oversize chunk fingerprint missing: end of the chunk base renderer')
    body = body[:end.start() + 1]
    payload = _one(r'=(' + W + r')\(\{segments:' + W + ',transitions:' + W + ',voiceoverSource:' + W
                   + r'\.voiceover_path,voiceoverDurationSec:' + W + r'\.duration_s,filename:`chunk_\$\{' + W + r'\}\.mp4`', body, 'payload builder')
    paths, tmp = _one(r',' + W + '=(' + W + r')\.chunkBaseVideoPath\(' + W + ',' + W + r'\),' + W + '=(' + W + r')\(' + W + r'\);return ', body, 'chunk path and temp path')
    mock = _one(r':(' + W + r')\(\)\?await ' + W + r'\(\{targetPath:' + W + ',voiceoverDurationSec:', body, 'mock check')
    compose = _one(r':await (' + W + r')\(\{payload:' + W + ',targetPath:' + W + ',jobId:' + W + ',chunkId:' + W
                   + r'\.id,contentSeconds:' + W + r'\.duration_s,checkpoint:' + W + r'\}\),', body, 'composition call')
    finish = _one(r'\}\),(' + W + r')\(' + W + ',' + W + r'\)\}$', body, 'atomic finish')
    # The step must call the renderer from exactly one place, so wrapping the binding covers every chunk.
    if len(re.findall(r'(?<![\w$.])' + re.escape(render) + r'\(', text)) != 2:
        raise RuntimeError('oversize chunk fingerprint missing or ambiguous: renderer call site')
    return {'render': render, 'payload': payload, 'paths': paths, 'tmp': tmp, 'mock': mock, 'compose': compose, 'finish': finish}


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('oversize chunk hook duplicated')
        return text
    n = names(text)
    hook = (f'\n{MARKER};(()=>{{try{{{n["render"]}=__vfCustom.wrapOversizeChunk({n["render"]},{{'
            f'buildPayload:a=>{n["payload"]}(a),renderPart:a=>{n["compose"]}(a),'
            f'basePath:(s,c)=>{n["paths"]}.chunkBaseVideoPath(s,c),tmpPath:f=>{n["tmp"]}(f),'
            f'finish:(t,f)=>{n["finish"]}(t,f),isMock:()=>{n["mock"]}()}});'
            '__vfCustom.report("oversizeChunk",true)}catch(e){__vfCustom.report("oversizeChunk",false,String(e))}})();\n')
    return text + hook


if __name__ == '__main__':
    import sys
    src = open(sys.argv[1], encoding='utf-8').read()
    print(names(src))
    if len(sys.argv) > 2:
        out = patch_node(src)
        open(sys.argv[2], 'w', encoding='utf-8', newline='').write(out)
        print('written', sys.argv[2], len(out) - len(src), 'bytes added')
