"""Finish-first job priority (node/job-priority.cjs) bound to the native scheduler.

Native priority is fixed at job start from queued_at, so queue rewrites can push
fresh jobs ahead of videos that are nearly finished. The helper periodically
re-ranks registered jobs by native pipeline progress. Getters keep it safe when
the scheduler module initialises after this tail hook.
"""
import re

MARKER = '/* vf-custom:job-priority-v1 */'


def _one(pattern, text, what):
    found = re.findall(pattern, text)
    if len(found) != 1:
        raise RuntimeError('Required job priority fingerprint missing or ambiguous: ' + what)
    return found[0]


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Required job priority hook duplicated')
        return text
    _, _, jobs, _ = _one(r'function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\.get\(\2\)\?\.priority\?\?([\w$]+)\}', text, 'priority registry')
    lanes = _one(r'function [\w$]+\(([\w$]+)\)\{let ([\w$]+)=([\w$]+)\.get\(\1\);return \2\|\|\(\2=\{activeTotal:0,activeByJob:new Map',
                 text, 'lane states')[2]
    progress, db, _, _ = _one(r'function ([\w$]+)\(e,t=null\)\{let r=t\|\|([\w$]+)\.prepare\("SELECT \* FROM pipeline_jobs WHERE job_id = \?"\)'
                              r'\.get\(e\);return r\?([\w$]+)\(\{pipelineRow:r,\.\.\.([\w$]+)\(e\)\}\):null\}', text, 'pipeline progress')
    drain = _one(r'async function ([\w$]+)\(\)\{await Promise\.all\(\[\.\.\.' + re.escape(lanes) + r'\.keys\(\)\]\.map\(e=>[\w$]+\(e\)\)\)\}',
                 text, 'drain all lanes')
    hook = (
        f'\n{MARKER};try{{__vfCustom.installJobPriority({{getJobs:()=>{jobs},getLanes:()=>{lanes},'
        f'progress:e=>{progress}(e),getDb:()=>{db},wake:()=>{{{drain}().catch(()=>{{}})}}}});'
        '__vfCustom.report("jobPriority",true)}catch(e){__vfCustom.report("jobPriority",false,String(e))}\n'
    )
    return text + hook
