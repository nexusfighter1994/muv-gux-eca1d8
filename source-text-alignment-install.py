"""Bounded recovery at the native source-preserving TTS partition, never at a provider."""
import re

MARK = '/* vf-custom:source-text-alignment-v1 */'
END = '/* vf-custom:source-text-alignment-end */'
ID = r'[\w$]+'

def patch_node(text):
    original = text
    marked = MARK in text or END in text
    if marked:
        if text.count(MARK) != 1 or text.count(END) != 1:
            raise RuntimeError('Partial/duplicate source text alignment patch')
        text, count = re.subn(re.escape(MARK) + r'.*?:(' + ID + r')' + re.escape(END), r'\1', text)
        if count != 1:
            raise RuntimeError('Malformed source text alignment patch')
    pattern = re.compile(
        r'let (?P<preserve>' + ID + r')=' + ID + r'\(\{intake:' + ID +
        r',snapshot:' + ID + r'\.generationSnapshot\?\?null,recordedCleanupMode:' + ID +
        r'\?\.cleanupMode\?\?null\}\),\{cuts:' + ID + r',keptChunkPauses:' + ID +
        r'\}=' + ID + r'\(\{aligned:(?P<aligned>' + ID + r'),durationSeconds:(?P<duration>' + ID +
        r'),preserveSourceTiming:(?P=preserve),onFallback:')
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise RuntimeError('Source timeline call fingerprint missing/ambiguous')
    call = matches[0]
    prefix = text[text.rfind('async function ', 0, call.start()):call.start()]
    header = re.match(r'async function ' + ID + r'\(' + ID + r'\)\{let\{jobId:' + ID + r',priorResults:' + ID +
                      r',emit:(?P<emit>' + ID + r'),setStageDetail:' + ID + r',checkAbort:(?P<abort>' + ID + r'),nowIso:', prefix)
    alignment = re.search(r'let ' + ID + r'=(?P<wordsfn>' + ID + r')\((?P<transcript>' + ID +
                          r')\.words\),' + re.escape(call['aligned']) + r',' + ID + r'=!1;try\{' +
                          re.escape(call['aligned']) + r'=(?P<approx>' + ID + r')\?' + ID +
                          r'\(\{scriptChunks:(?P<chunks>' + ID + r'),durationSeconds:' + re.escape(call['duration']) +
                          r',language:(?P<language>' + ID + r')\}\):', prefix)
    partition = re.findall(r'function (' + ID + r')\([^)]*\)\{.{0,140}?throw new Error\("partitionSourceTimelineCuts: durationSeconds must be positive"\)', text)
    if not header or not alignment or len(partition) != 1:
        raise RuntimeError('TTS alignment/abort/partition fingerprint missing')
    a = call['aligned']
    value = (MARK + f'{call["preserve"]}&&!{alignment["approx"]}?await __vfCustom.repairSourceTimeline({{'
             f'aligned:{a},words:{alignment["wordsfn"]}({alignment["transcript"]}.words),'
             f'scriptChunks:{alignment["chunks"]},language:{alignment["language"]},durationSeconds:{call["duration"]},'
             f'partition:{partition[0]},checkAbort:{header["abort"]},'
             f'onRepair:data=>{header["emit"]}({{step:"tts",message:"Source timeline repaired using transcript text anchors; original audio and pauses preserved.",data}})'
             f'}}):{a}' + END)
    result = text[:call.start('aligned')] + value + text[call.end('aligned'):]
    if marked and result != original:
        raise RuntimeError('Source text alignment patch drift')
    return result
