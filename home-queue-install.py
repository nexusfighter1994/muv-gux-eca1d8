"""Thin, verified hooks into native Node and FFlow signed queue contracts."""
import ast
import re


def patch_node(text):
    marker='/* vf-custom:independent-home-queue-k5 */'
    if marker in text:return patch_direct(text)
    if 'function hQr(e,{jobId:t,priority:r,resourceKey:n,opKey:o,quality:i,signal:s})' in text:
        return patch_current_node(text)
    for previous in ('/* vf-custom:independent-home-queue-v1 */','/* vf-custom:independent-home-queue-v2 */','/* vf-custom:independent-home-queue-k3 */','/* vf-custom:independent-home-queue-v4 */'):
        if previous in text:text=text[:text.index(previous)]
    head='function r8r(e,{jobId:t,priority:r,resourceKey:n,opKey:o,quality:i,signal:a})'
    if head in text:
        if text.count(head)!=1:raise RuntimeError('Native waiter metadata fingerprint changed')
        text=text.replace(head,head.replace('signal:a})','signal:a,homeKind=null})'))
        start=text.index('function r8r(');end=text.index('async function r0e(',start)
        body=text[start:end]
        if body.count('quality:i,queuedAtMs:')!=1:raise RuntimeError('Native waiter record changed')
        body=body.replace('quality:i,queuedAtMs:','quality:i,homeKind,queuedAtMs:')
        text=text[:start]+body+text[end:]
    trim='deadlineTs:Ze,signal:kt}))),He=F?String(n||"")'
    replacement='deadlineTs:Ze,signal:kt})),{homeKind:"video-trim",operation:"fflow-video-trim",signal:kt}),He=F?String(n||"")'
    if replacement not in text:
        if text.count(trim)!=1:raise RuntimeError('Exact native video-trim caller changed')
        text=text.replace(trim,replacement)
    normalize='l.toFixed(3),"-movflags","+faststart",t],{timeoutMs:18e4})),!0}async function RUn('
    normalize_new='l.toFixed(3),"-movflags","+faststart",t],{timeoutMs:18e4}),{homeKind:__vfCustom.canHomeNormalizeFilter(r)?"video-normalize":null,operation:"home-broll-normalize"}),!0}async function RUn('
    if normalize_new not in text:
        if text.count(normalize)!=1:raise RuntimeError('Exact native bar-fill normalization changed')
        text=text.replace(normalize,normalize_new)
    start=text.find('function r0e(')
    end=text.find('async function ',start+15)
    if start<0 or end<start:raise RuntimeError('Home queue native run fingerprint changed')
    run=text[start:end]
    if (run.count('boosted:!!g?.boosted')+run.count('boosted:g?.homeScope||!!g?.boosted')!=1
            or run.count('S=F4e({lane:i,resourceKey:o,')+
            run.count('S=F4e({lane:i,resourceKey:b.boosted&&typeof b.boosted==="object"?"ffmpegHome":o,')!=1):
        raise RuntimeError('Home queue lease or memory scope fingerprint changed')
    run=run.replace('boosted:!!g?.boosted','boosted:g?.homeScope||!!g?.boosted')
    run=run.replace('S=F4e({lane:i,resourceKey:o,',
        'S=F4e({lane:i,resourceKey:b.boosted&&typeof b.boosted==="object"?"ffmpegHome":o,')
    run=run.replace('opKey:f.segmentType||null,quality:f.quality||null,signal:a})',
        'opKey:f.segmentType||null,quality:f.quality||null,signal:a,homeKind:f.homeKind||null})')
    text=text[:start]+run+text[end:]
    return patch_direct(text+'\n'+home_hook())


def home_hook():
    marker='/* vf-custom:independent-home-queue-k5 */'
    return (marker+";(()=>{if(!(__vfCustom.modEnabled('homeQueue')&&__vfCustom.modEnabled('homeFfmpeg'))&&!__vfCustom.modEnabled('homeSiglip'))return;let timer;const connect=()=>{if(!globalThis.__vfCustomApp)return;"
          'try{k7=__vfCustom.wrapHomeRamEstimate(k7);__vfCustom.installHomeAdmission({scheduler:Oe,getState:()=>bJ("ffmpeg"),'
          'getContext:()=>P4e.getStore(),claim:w=>QCi("ffmpeg",bJ("ffmpeg"),w),'
          'runIndependent:fn=>__vfCustom.withoutHomeFfmpegLane(()=>P4e.getStore(),(context,run)=>P4e.run(context,run),fn),'
          'getAdmission:()=>B4e,setAdmission:v=>{B4e=v},getRelease:()=>t8r,setRelease:v=>{t8r=v},'
          'app:globalThis.__vfCustomApp,requireOwner:globalThis.__vfCustomOwner});'
          '__vfCustom.wrapHomeFflowClient(co,()=>P4e.getStore());'
          'const nativeExec=oAt;oAt=__vfCustom.wrapHomeNormalizeExec(oAt,{' 
          'getContext:()=>P4e.getStore(),getBinary:()=>Q6r(),'
          'runCli:async(payload,options)=>{const request=__vfCustom.nativeNormalizeRequest(payload);if(!request)return {offloaded:false};'
          'const result=await nativeExec("python",["-B","/app/engines/fflow/src/core/pc_node_normalize_cli.py",Buffer.from(JSON.stringify(request)).toString("base64")],'
          '{...options,timeoutMs:210000});return JSON.parse(result.stdout)},'
          'runRecovery:(scope,run,signal)=>globalThis.__vfHomeQueue.runRecovery(scope,run,signal),report:__vfCustom.report});'
          'clearInterval(timer)}'
          'catch(e){__vfCustom.report("homeQueue",false,String(e))}};'
          'timer=setInterval(connect,500);timer.unref();connect()})();\n')


def patch_current_node(text):
    """Adapt the reviewed 2026.10.13.7 scheduler without replacing its native logic."""
    def replace_once(old, new):
        nonlocal text
        if text.count(old) != 1:
            raise RuntimeError('Current Home hook fingerprint changed: ' + old[:100])
        text = text.replace(old, new, 1)

    bindings = {'k7':'fK', 'bJ':'DJ', 'P4e':'S0e', 'QCi':'sNi', 'B4e':'A5e',
                't8r':'Rkt', 'co':'Vn', 'oAt':'Z_t', 'Q6r':'mjr', 'F4e':'y5e',
                'cv':'Qv', 'Iy':'Hg', 'F1n':'H1n'}
    signatures = [
        'function fK({resourceKey:e,opKey:t=null,quality:r=null,jobId:n=null}={})',
        'function DJ(e){let t=j$.get(e);',
        'function sNi(e,t,r,{boosted:n=!1}={})',
        'function A5e(e,t,r,n=e,o=Ikt(t))',
        'async function Rkt(e,t,r,n=e,o=!1)',
        'function Z_t(e,t,{timeoutMs:r=J_t,signal:n,chunkIndex:o,onSpawn:i}={})',
        'function mjr(){return process.env.VIDFORGE_FFMPEG_PATH||"ffmpeg"}',
    ]
    for signature in signatures:
        if text.count(signature) != 1:
            raise RuntimeError('Current native binding missing: ' + signature)
    embed = re.findall(r'async function ([\w$]+)\(\{query:e,extraQueries:t=\[\],negativeQueries:r=\[\],shots:n,deadlineTs:o,signal:i\}\)', text)
    if len(embed) != 1:
        raise RuntimeError('Current native embedder changed')
    bindings['F1n'] = embed[0]

    head='function hQr(e,{jobId:t,priority:r,resourceKey:n,opKey:o,quality:i,signal:s})'
    replace_once(head, head.replace('signal:s})', 'signal:s,homeKind=null})'))
    replace_once('quality:i,queuedAtMs:', 'quality:i,homeKind,queuedAtMs:')
    replace_once('deadlineTs:Je,signal:Rt})}))),',
                 'deadlineTs:Je,signal:Rt})}),{homeKind:"video-trim",operation:"fflow-video-trim",signal:Rt})),')
    old='c.toFixed(3),"-movflags","+faststart",t],{timeoutMs:18e4})),!0}async function N8n('
    replace_once(old, 'c.toFixed(3),"-movflags","+faststart",t],{timeoutMs:18e4}),{homeKind:__vfCustom.canHomeNormalizeFilter(r)?"video-normalize":null,operation:"home-broll-normalize"}),!0}async function N8n(')
    replace_once('boosted:!!y?.boosted,cooldownProbe:!!y?.cooldownProbe',
                 'boosted:y?.homeScope||!!y?.boosted,cooldownProbe:!!y?.cooldownProbe')
    replace_once('C=y5e({lane:s,resourceKey:i,',
                 'C=y5e({lane:s,resourceKey:A.boosted&&typeof A.boosted==="object"?"ffmpegHome":i,')
    replace_once('opKey:m.segmentType||null,quality:m.quality||null,signal:a}),A={lane:',
                 'opKey:m.segmentType||null,quality:m.quality||null,signal:a,homeKind:m.homeKind||null}),A={lane:')
    # Only translate identifiers in our generated hook, never in native code.
    hook = patch_direct(home_hook())
    hook = re.sub(r'\b(?:' + '|'.join(map(re.escape, bindings)) + r')\b',
                  lambda m: bindings[m.group(0)], hook)
    return text + '\n' + hook


def patch_direct(text):
    marker='/* vf-custom:home-direct-credit-v1 */'
    if marker in text:return patch_library_trim(text)
    anchor='__vfCustom.wrapHomeFflowClient(co,()=>P4e.getStore());'
    if text.count(anchor)!=1:raise RuntimeError('Home direct installer fingerprint changed')
    hook=(marker+'__vfCustom.installHomeDirect({scheduler:Oe,getSlotMeasurer:()=>F4e,'
          'setSlotMeasurer:v=>{F4e=v},getContext:()=>P4e.getStore(),'
          'runNativeContext:(scope,fn)=>{const c=P4e.getStore(),old=c?.leases?.get("ffmpeg");'
          'if(!c||old?.boosted?.nonce!==scope.nonce)throw Error("Native recovery scope mismatch");'
          'const leases=new Map(c.leases);leases.set("ffmpeg",{...old,boosted:false});return P4e.run({...c,leases},fn)},'
          'runRecovery:(scope,fn,signal)=>globalThis.__vfHomeQueue.runRecovery(scope,fn,signal)});')
    return patch_library_trim(text.replace(anchor,anchor+hook))


def patch_library_trim(text):
    marker='/* vf-custom:home-library-trim-v1 */'
    if marker in text:return patch_home_siglip(text)
    anchor='runRecovery:(scope,fn,signal)=>globalThis.__vfHomeQueue.runRecovery(scope,fn,signal)});'
    if text.count(anchor)!=1:raise RuntimeError('Native direct installation boundary changed')
    hook=(marker+'__vfCustom.installHomeLibraryTrim({scheduler:Oe,getSlotMeasurer:()=>F4e,'
          'setSlotMeasurer:v=>{F4e=v},getContext:()=>P4e.getStore()});')
    return patch_home_siglip(text.replace(anchor,anchor+hook))


def patch_home_siglip(text):
    marker='/* vf-custom:home-siglip-admission-v1 */'
    if marker in text:return text
    anchor='__vfCustom.installHomeLibraryTrim({scheduler:Oe,getSlotMeasurer:()=>F4e,setSlotMeasurer:v=>{F4e=v},getContext:()=>P4e.getStore()});'
    if text.count(anchor)!=1:raise RuntimeError('Home SigLIP native hook boundary changed')
    hook=(marker+'__vfCustom.installHomeSiglipStartup({scheduler:Oe,getState:()=>bJ("siglip"),'
      'getContext:()=>P4e.getStore(),claim:w=>{const c=cv.get("siglip"),p=c?.probing;QCi("siglip",bJ("siglip"),w);if(c&&cv.get("siglip")===c)c.probing=p},'
      'getAdmission:()=>B4e,setAdmission:v=>{B4e=v},getRelease:()=>t8r,setRelease:v=>{t8r=v},'
      'getSlotMeasurer:()=>F4e,setSlotMeasurer:v=>{F4e=v},'
      'runIndependent:fn=>{const c=P4e.getStore();if(!c)return fn();const lanes=new Set(c.lanes||[]),leases=new Map(c.leases||[]);'
      'lanes.delete("siglip");leases.delete("siglip");return P4e.run({...c,lanes,leases},fn)},'
      'runNativeContext:(scope,fn)=>{const c=P4e.getStore(),old=c?.leases?.get("siglip");'
      'if(!c||old?.boosted?.nonce!==scope.nonce)throw Error("Native SigLIP recovery scope mismatch");'
      'const leases=new Map(c.leases);leases.set("siglip",{...old,boosted:false});return P4e.run({...c,leases,homeSiglipRecovery:true},fn)},'
      'getClient:()=>Iy,getFflow:()=>co,getEmbedder:()=>F1n,setEmbedder:v=>{F1n=v},app:globalThis.__vfCustomApp,requireOwner:globalThis.__vfCustomOwner});')
    return text.replace(anchor,anchor+hook)


def patch_jobs(text):
    marker='# vf-custom:independent-home-queue-v1'
    if marker in text:
        text=text.replace("return ok and data.output and type(data.output.filename) == 'string'",
                            "return ok and type(data) == 'table' and type(data.output) == 'table' and type(data.output.filename) == 'string'").replace(
                            '(not home and (active_limit <= 0 or native_count < active_limit))',
                            '(not home and active_limit >= 0 and (active_limit == 0 or native_count < active_limit))')
        return patch_home_names(text)
    tree=ast.parse(text)
    cls=next(x for x in tree.body if isinstance(x,ast.ClassDef) and x.name=='JobQueue')
    fn=next(x for x in cls.body if isinstance(x,ast.AsyncFunctionDef) and x.name=='dequeue_and_start')
    lines=text.splitlines(keepends=True)
    body=''.join(lines[fn.lineno-1:fn.end_lineno])
    old="""        if active_limit and active_limit > 0 and redis.call('scard', active_set_key) >= active_limit then
            return {'__capacity_full__'}
        end

        -- Pop job from queue (LPOP for FIFO order)
        local job_id = redis.call('lpop', queue_key)
"""
    new="""        local home_limit = tonumber(ARGV[6]) or 1
        local function is_home(id)
            local raw = redis.call('hget', job_key_prefix .. id, 'composition')
            if not raw then return false end
            local ok, data = pcall(cjson.decode, raw)
            return ok and type(data) == 'table' and type(data.output) == 'table' and type(data.output.filename) == 'string'
                and string.match(data.output.filename, '^vfhome%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%.mp4$') ~= nil
        end
        local native_count, home_count = 0, 0
        for _, id in ipairs(redis.call('smembers', active_set_key)) do
            if is_home(id) then home_count = home_count + 1 else native_count = native_count + 1 end
        end
        local job_id = nil
        for _, id in ipairs(redis.call('lrange', queue_key, 0, 63)) do
            local home = is_home(id)
            if (home and home_count < home_limit) or (not home and active_limit >= 0 and (active_limit == 0 or native_count < active_limit)) then
                job_id = id
                redis.call('lrem', queue_key, 1, id)
                break
            end
        end
"""
    if body.count(old)!=1:raise RuntimeError('Home queue Lua claim fingerprint changed')
    # Preserve native FIFO and capacity checks when the independent Home queue is off.
    gated = ("        local job_id = nil\n        if ARGV[7] == '1' then\n"
             + new.replace('        local job_id = nil\n', '')
             + '        else\n' + old.replace('local job_id =', 'job_id =')
             + '        end\n')
    body=body.replace(old,gated)
    oldargs='            worker_id,\n            lease_id,\n        )'
    if body.count(oldargs)!=1:raise RuntimeError('Home queue Redis arguments changed')
    body=body.replace(oldargs,"            worker_id,\n            lease_id,\n            home_worker_capacity(),\n            '1' if mod_enabled('homeQueue') and mod_enabled('homeFfmpeg') else '0',\n        )")
    body=body.replace('        # Lua script for atomic dequeue-and-start',
        '        '+marker+'\n        from src.core.pc_home_queue import home_worker_capacity\n        from src.core.mod_flags import mod_enabled\n\n        # Lua script for atomic dequeue-and-start')
    return patch_home_names(''.join(lines[:fn.lineno-1])+body+''.join(lines[fn.end_lineno:]))


def patch_home_names(text):
    old="""            return ok and type(data) == 'table' and type(data.output) == 'table' and type(data.output.filename) == 'string'
                and string.match(data.output.filename, '^vfhome%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%.mp4$') ~= nil"""
    new="""            if not ok or type(data) ~= 'table' then return false end
            local name = nil
            if type(data.output) == 'table' then name = data.output.filename
            elseif type(data.output) == 'string' then
                name = string.match(data.output, '^outputs/video/trim/(vfhome%-[^/]+%.mp4)$')
            end
            return type(name) == 'string'
                and string.match(name, '^vfhome%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%-%x+%.mp4$') ~= nil"""
    if new in text:return text
    if text.count(old)!=1:raise RuntimeError('Native Home name classification changed')
    return text.replace(old,new)


def patch_worker(text):
    marker='# vf-custom:independent-home-worker-v1'
    if marker in text:return text
    anchor='if __name__ == "__main__":'
    if text.count(anchor)!=1:raise RuntimeError('Native worker startup fingerprint changed')
    tree=ast.parse(text)
    cls=next(n.name for n in tree.body if isinstance(n,ast.ClassDef)
             and any(isinstance(fn,ast.AsyncFunctionDef) and fn.name=='_process_job' for fn in n.body))
    return text.replace(anchor,marker+'\nfrom src.core.pc_home_queue import install_worker as _vf_home_worker\n'
        '_vf_home_worker('+cls+', FFmpegExecutor)\n\n'+anchor)
