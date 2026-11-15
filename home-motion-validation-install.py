"""Exact, fail-closed author-loop validation offload; contract gate stays native."""
MARKER='/* vf-custom:home-motion-validation-v1 */'
X_OLD='async function xie({schedulerImpl:e,frameshiftImpl:t,jobId:r,built:n}){return e.run(r,"frameshift",async()=>j3()?{valid:!0,issues:[]}:t.validateComposition({compositionHtml:n.html,assets:n.assets,fps:v_e,resolution:fWt}))}'
X_NEW='async function xie({schedulerImpl:e,frameshiftImpl:t,jobId:r,built:n}){return e.run(r,"frameshift",async()=>j3()?{valid:!0,issues:[]}:__vfCustom.validateHomeMotion(t,{compositionHtml:n.html,assets:n.assets,fps:v_e,resolution:fWt},r,cl()))}'
L_START='async function lWt({schedulerImpl:e,frameshiftImpl:t,contractGate:r,jobId:n,built:o,topicFamily:i}){return e.run(n,"frameshift",async()=>{if(j3())return{valid:!0,issues:[],contractGate:{valid:!0,issues:[],skipped:"mock_mode",samples:0}};let s=await t.validateComposition({compositionHtml:o.html,assets:o.assets,fps:v_e,resolution:fWt});if(!s?.valid)return s;let a=await r('
L_NEW='async function lWt({schedulerImpl:e,frameshiftImpl:t,contractGate:r,jobId:n,built:o,topicFamily:i}){if(j3())return e.run(n,"frameshift",async()=>({valid:!0,issues:[],contractGate:{valid:!0,issues:[],skipped:"mock_mode",samples:0}}));let s=await e.run(n,"frameshift",()=>__vfCustom.validateHomeMotion(t,{compositionHtml:o.html,assets:o.assets,fps:v_e,resolution:fWt},n,cl()));if(!s?.valid)return s;return e.run(n,"frameshift",async()=>{let a=await r('

def patch_node(text):
    if MARKER in text:
        if text.count(MARKER)!=1 or text.count(X_NEW)!=1 or text.count(L_NEW)!=1: raise RuntimeError('Motion validation hook drift')
        return text
    for old in (X_OLD,L_START):
        if text.count(old)!=1: raise RuntimeError('Motion validation native anchor missing')
    text=text.replace(X_OLD,X_NEW).replace(L_START,L_NEW)
    return text+'\n'+MARKER+'\n'
