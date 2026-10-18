"""Thin version-checked Node hook for closed Home GPU media recipes."""
MARKER = '/* vf-custom:home-media-v1 */'
SIGNATURES = (
    'function HDr(){return process.env.VIDFORGE_FFMPEG_PATH||"ffmpeg"}',
    'function qAt(e,t,{timeoutMs:r=zAt,signal:n,chunkIndex:o,onSpawn:i}={})',
    '__vfCustom.installHomeLibraryTrim({scheduler:Me,',
)


def install_expression(module='__vfMedia', recipes='__vfMediaRecipes'):
    return (f'{module}.installHomeMedia({{scheduler:Me,getExec:()=>qAt,setExec:v=>{{qAt=v}},'
        'getContext:()=>fhe.getStore(),getBinary:()=>HDr(),'
        'runCli:async(payload,options)=>{const result=await qAt("python",'
        '["-B","/app/engines/fflow/src/core/pc_node_media_cli.py",Buffer.from(JSON.stringify(payload)).toString("base64")],'
        '{...options,timeoutMs:210000});return JSON.parse(result.stdout)},'
        'runRecovery:(scope,fn,signal)=>globalThis.__vfHomeQueue.runRecovery(scope,fn,signal),'
        'runNativeContext:(scope,fn)=>{const c=fhe.getStore(),old=c?.leases?.get("ffmpeg");'
        'if(!c||old?.boosted?.nonce!==scope.nonce)throw Error("Native recovery scope mismatch");'
        'const leases=new Map(c.leases);leases.set("ffmpeg",{...old,boosted:false});return fhe.run({...c,leases},fn)},'
        f'classifyCallback:{recipes}.classifyHomeMediaCallback,classifyArgv:{recipes}.classifyHomeMediaArgv,'
        'enabled:()=>__vfCustom.modEnabled("homeQueue")&&__vfCustom.modEnabled("homeFfmpeg"),'
        'report:(name,error)=>__vfCustom.report(name,false,error)})')


def patch_node(text):
    if MARKER in text:
        return text
    for signature in SIGNATURES:
        if text.count(signature) != 1:
            raise RuntimeError('Home media native fingerprint changed: ' + signature)
    hook = ('\n' + MARKER + '\n'
        'import * as __vfMedia from "./vf-custom/home-media.mjs";\n'
        'import * as __vfMediaRecipes from "./vf-custom/home-media-recipes.mjs";\n'
        ';(()=>{let timer;const connect=()=>{if(!globalThis.__vfHomeQueue)return;'
        'try{' + install_expression() + ';clearInterval(timer)}'
        'catch(e){clearInterval(timer);__vfCustom.report("homeMedia",false,e.name)}};'
        'timer=setInterval(connect,500);timer.unref();connect()})();\n')
    return text + hook
