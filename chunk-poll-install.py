"""Verified native poll/chunk boundaries; rendering and scheduler logic stay native."""
import re

MARKER='/* vf-custom:chunk-poll-recovery-v1 */'

def patch_node(text):
    if MARKER in text:return text
    poll=re.findall(r'async function ([\w$]+)\(\{fetchStatus:e,isDone:t,isFailed:r,intervalMs:n=',text)
    chunk=re.findall(r'async function ([\w$]+)\(\{payload:e,targetPath:t,jobId:r,chunkId:n,contentSeconds:o,checkpoint:i\}\)\{if\(![\w$]+\("ffmpegSlotRelease"\)',text)
    client=re.findall(r'async function [\w$]+\(e,\{client:t=([\w$]+),fallbackDelayMs:r=3e3,waitSeconds:n=',text)
    scheduler=re.findall(r'([\w$]+)\.run\(r,"ffmpeg",\(\)=>[\w$]+\(\{checkpoint:A,remoteTaskId:y,submit:d,poll:p\}\),s\)',text)
    if any(len(x)!=1 for x in (poll,chunk,client,scheduler)):
        raise RuntimeError('Native chunk/poll recovery boundary changed: '+repr((poll,chunk,client,scheduler)))
    return ('import __vfChunkRecovery from "./vf-custom/home-chunk-recovery.cjs";\n'+text+'\n'+MARKER+
        ';{const guard=__vfChunkRecovery.createRecovery({'
        'getContext:()=>globalThis.__vfHomeContext?.(),'
        'validScope:s=>globalThis.__vfHomeQueue?.validScope(s)===true,'
        'isAborted:id=>'+scheduler[0]+'.isJobAborted(id),'
        'cancel:id=>'+client[0]+'.request(`/v1/jobs/${encodeURIComponent(id)}/cancel`,{method:"POST",timeoutMs:15000,operation:"POST /v1/jobs/:jobId/cancel"}),'
        'report:(message,id)=>console.warn("[vf-home-recovery]",message,id)});'
        +poll[0]+'=guard.wrapPoll('+poll[0]+');'
        +chunk[0]+'=guard.wrapChunk('+chunk[0]+');'
        +scheduler[0]+'.run=guard.wrapRun('+scheduler[0]+'.run);'
        'globalThis.__vfHomeChunkRecovery=guard;}\n')
