"""VidForge Custom layer: installs our additions into a STOCK VidForge image at build time.

Update-safe by design:
- All our logic lives in separate files (node/, fflow/, ui/). The stock code only gets thin hooks.
- Hooks use verified fingerprints and explicitly reviewed adapters for changed bundles.
- Every required hook must pass the independent contract gate; missing hooks abort the build.
- Report: /app/server/dist/vf-custom/hooks-build.json (shown in the Custom tab).

Update procedure: pin BASE, build, run compatibility tests, back up, deploy, verify live state.
"""
import ast
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK_GATE = runpy.run_path(str(HERE / 'validate-hook-report.py'))
DIST = Path(os.environ.get('VF_DIST', '/app/server/dist'))
PUBLIC = Path(os.environ.get('VF_PUBLIC', '/app/server/public'))
CORE = Path(os.environ.get('VF_FFLOW_CORE', '/app/engines/fflow/src/core'))
ROUTES = Path(os.environ.get('VF_FFLOW_ROUTES', '/app/engines/fflow/src/api/routes.py'))
MARK = 'vf-custom'
report = {}
_long_spec = importlib.util.spec_from_file_location('vf_long_install', HERE / 'long-assembly-install.py')
_long_install = importlib.util.module_from_spec(_long_spec)
_long_spec.loader.exec_module(_long_install)
_memory_spec = importlib.util.spec_from_file_location('vf_memory_install', HERE / 'render-memory-install.py')
_memory_install = importlib.util.module_from_spec(_memory_spec)
_memory_spec.loader.exec_module(_memory_install)
_fs_limit_spec = importlib.util.spec_from_file_location('vf_fs_limit_install', HERE / 'frameshift-limit-cache-install.py')
_fs_limit_install = importlib.util.module_from_spec(_fs_limit_spec)
_fs_limit_spec.loader.exec_module(_fs_limit_install)
_capacity_spec = importlib.util.spec_from_file_location('vf_capacity_install', HERE / 'home-graphics-capacity-install.py')
_capacity_install = importlib.util.module_from_spec(_capacity_spec)
_capacity_spec.loader.exec_module(_capacity_install)
_priority_spec = importlib.util.spec_from_file_location('vf_priority_install', HERE / 'job-priority-install.py')
_priority_install = importlib.util.module_from_spec(_priority_spec)
_priority_spec.loader.exec_module(_priority_install)
_route_spec = importlib.util.spec_from_file_location('vf_route_install', HERE / 'frameshift-route-install.py')
_route_install = importlib.util.module_from_spec(_route_spec)
_route_spec.loader.exec_module(_route_install)
_wordsync_spec = importlib.util.spec_from_file_location('vf_wordsync_install', HERE / 'segment-wordsync-install.py')
_wordsync_install = importlib.util.module_from_spec(_wordsync_spec)
_wordsync_spec.loader.exec_module(_wordsync_install)
_broll_spec = importlib.util.spec_from_file_location('vf_broll_reuse_install', HERE / 'broll-reuse-install.py')
_broll_install = importlib.util.module_from_spec(_broll_spec)
_broll_spec.loader.exec_module(_broll_install)
_proc_spec = importlib.util.spec_from_file_location('vf_proc_scan_install', HERE / 'proc-scan-cache-install.py')
_proc_install = importlib.util.module_from_spec(_proc_spec)
_proc_spec.loader.exec_module(_proc_install)
FRAMESHIFT_LIB = Path(os.environ.get('VF_FRAMESHIFT_LIB', str(DIST.parent.parent / 'render' / 'frameshift' / 'lib')))


def long_assembly(text):
    result = _long_install.patch_node(text)
    note('node.longAssembly', True)
    return result

_home_spec = importlib.util.spec_from_file_location('vf_home_install', HERE / 'home-queue-install.py')
_home_install = importlib.util.module_from_spec(_home_spec)
_home_spec.loader.exec_module(_home_install)
_fx_retention_spec = importlib.util.spec_from_file_location('vf_fx_retention_install', HERE / 'fx-dir-retention-install.py')
_fx_retention_install = importlib.util.module_from_spec(_fx_retention_spec)
_fx_retention_spec.loader.exec_module(_fx_retention_install)
_fx_sentinel_spec = importlib.util.spec_from_file_location('vf_fx_sentinel_install', HERE / 'fx-worker-sentinel-install.py')
_fx_sentinel_install = importlib.util.module_from_spec(_fx_sentinel_spec)
_fx_sentinel_spec.loader.exec_module(_fx_sentinel_install)


def note(name, ok, detail=''):
    report[name] = 'ok' if ok else f'skipped: {detail}'
    print(f'[vf-custom] {name}: {report[name]}')


def read(path):
    raw = Path(path).read_bytes().decode('utf-8')
    crlf = '\r\n' in raw
    return raw.replace('\r\n', '\n'), crlf


def write(path, text, crlf):
    Path(path).write_bytes((text.replace('\n', '\r\n') if crlf else text).encode('utf-8'))


# ---------------------------------------------------------------- FFlow (Python)
FFMPEG_ANCHOR = '        logger.info(f"Executing FFmpeg: {\' \'.join(cmd[:10])}...")\n'
FFMPEG_HOOK = '''        # vf-custom: optional authenticated home-PC executor (encode slots only; probes stay local).
        if {guard}:
            from src.core.pc_ffmpeg_hook import try_offload as _pc_try_offload
            _pc_result = await _pc_try_offload(
                cmd, timeout=timeout, expected_duration=expected_duration,
                cancellation_event=cancellation_event, cancellation_error=FFmpegCancelledError,
            )
            if _pc_result is not None:
                if progress_callback:
                    await progress_callback(FFmpegProgress(
                        out_time_us=int((expected_duration or 0) * 1_000_000), progress="end",
                    ))
                return _pc_result

'''


def fflow():
    _fx_retention_install.install(CORE.parent.parent, apply=True)
    note('fflow.tempDirectoryRetention', True)
    _fx_sentinel_install.install(CORE.parent.parent, apply=True)
    note('fflow.fxOutputSentinel', True)
    for name in ('mod_flags.py', 'mod_boot.py', 'pc_ffmpeg_protocol.py', 'pc_transfer_limits.py', 'pc_ffmpeg_hook.py', 'pc_scene_hook.py', 'ffmpeg_slot_cleanup.py', 'pc_home_queue.py', 'pc_home_pool.py', 'pc_node_normalize_cli.py'):
        shutil.copy2(HERE / 'fflow' / name, CORE / name)
    for file, patch in ((CORE.parent / 'queue' / 'jobs.py', _home_install.patch_jobs),
                        (CORE.parent / 'queue' / 'worker.py', _home_install.patch_worker)):
        source, crlf = read(file)
        write(file, patch(source), crlf)
    note('fflow.homeQueue', True)
    target = CORE / 'ffmpeg.py'
    text, crlf = read(target)
    if MARK in text:
        note('fflow.ffmpegOffload', True)
    else:
        try:
            tree = ast.parse(text)
            executor = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'FFmpegExecutor')
            execute = next(n for n in executor.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'execute')
            args = [a.arg for a in execute.args.args]
            needed = ['command', 'timeout', 'expected_duration', 'progress_callback', 'cancellation_event']
            if not all(a in args for a in needed):
                raise RuntimeError('executor signature changed: ' + ','.join(args))
            if text.count(FFMPEG_ANCHOR) != 1:
                raise RuntimeError('executor log anchor not unique')
            guard = 'slot_kind == "ffmpeg"' if 'slot_kind' in args else 'True'
            patched = text.replace(FFMPEG_ANCHOR, FFMPEG_HOOK.format(guard=guard) + FFMPEG_ANCHOR)
            ast.parse(patched)
            write(target, patched, crlf)
            note('fflow.ffmpegOffload', True)
        except Exception as error:
            note('fflow.ffmpegOffload', False, str(error))

    text, crlf = read(target)
    slot_marker = '# vf-custom:ffmpeg-slot-cleanup-v1'
    if slot_marker not in text:
        for name in ('_try_acquire_global_process_slot', '_release_global_process_slot'):
            if text.count(f'async def {name}(') != 1:
                raise RuntimeError('Required FFmpeg process-slot fingerprint changed: ' + name)
        text += (
            '\n' + slot_marker + '\n'
            'from src.core.ffmpeg_slot_cleanup import install_slot_cleanup as _vf_install_slot_cleanup\n'
            'from src.core.mod_flags import mod_enabled as _vf_mod_enabled\n'
            "if _vf_mod_enabled('slotCleanup'):\n"
            '    _vf_install_slot_cleanup(FFmpegExecutor)\n'
        )
        ast.parse(text)
        write(target, text, crlf)
    note('fflow.slotCleanup', True)

    text, crlf = read(ROUTES)
    if MARK in text:
        note('fflow.sceneOffload', True)
        return
    pattern = re.compile(r'^(?P<i>[ ]+)metadata, shots = await asyncio\.to_thread\(\n(?P=i)    detect_video_scenes,\n(?P<body>(?:(?P=i)    .*\n)+?)(?P=i)\)\n', re.M)
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        note('fflow.sceneOffload', False, f'{len(matches)} scene detection call sites')
        return
    m = matches[0]
    i = m.group('i')
    original = m.group(0)
    replacement = (
        f'{i}# vf-custom: scene detection on the home PC first (same packages), native otherwise.\n'
        f'{i}from src.core.pc_scene_hook import finish_raw_scenes, try_scene_offload\n'
        f'{i}_pc_raw = await try_scene_offload(local_video_path, request.detection_threshold)\n'
        f'{i}if _pc_raw is not None:\n'
        f'{i}    metadata, shots = finish_raw_scenes(\n'
        f'{i}        _pc_raw,\n'
        f'{i}        request.min_duration_sec,\n'
        f'{i}        request.max_duration_sec,\n'
        f'{i}        request.fallback_interval_sec,\n'
        f'{i}    )\n'
        f'{i}else:\n'
        + ''.join('    ' + line + '\n' for line in original.rstrip('\n').split('\n'))
    )
    if 'local_video_path' not in m.group('body') or 'request.detection_threshold' not in m.group('body'):
        note('fflow.sceneOffload', False, 'scene call arguments changed')
        return
    patched = text[:m.start()] + replacement + text[m.end():]
    try:
        ast.parse(patched)
    except SyntaxError as error:
        note('fflow.sceneOffload', False, f'syntax {error}')
        return
    write(ROUTES, patched, crlf)
    note('fflow.sceneOffload', True)


# ---------------------------------------------------------------- Node bundle
def graphics():
    root = Path(os.environ.get('VF_GEOMAP', '/app/render/geomap'))
    subprocess.run(['node', str(HERE / 'helpers' / 'graphics-install.mjs'),
                    str(DIST / 'index.mjs'), str(root / 'index.js')], check=True)
    note('node.homeMap', True)
    note('node.homeMotion', True)


def geomap_isolation():
    root = Path(os.environ.get('VF_GEOMAP', '/app/render/geomap'))
    target = root / 'index.js'
    text, crlf = read(target)
    marker = '/* vf-custom:geomap-isolation */'
    if marker not in text:
        signature = 'export function render({ animationType, params, targetPath, mapboxToken, onProgress, signal, onPhase, look, language, engine }) {'
        if text.count(signature) != 1:
            raise RuntimeError('Required GeoMap render signature changed')
        text = text.replace(signature, signature.replace('export function render(', 'function renderInProcess('), 1)
        text += '''\n/* vf-custom:geomap-isolation */
import isolatedMaps from './geomap-isolated.cjs';
import { modEnabled } from '../../server/dist/vf-custom/mod-controls.mjs';
const isolatedRender = isolatedMaps.createIsolatedMapRenderer();
export function render(options) {
  return process.env.VIDFORGE_GEOMAP_ISOLATED_CHILD === '1' || !modEnabled('mapIsolation') || (options.engine || activeEngine()) === 'mapbox'
    ? renderInProcess(options) : isolatedRender(options);
}
render.isolationVersion = 'cartograph-process-v1';
'''
    for name in ('geomap-isolated.cjs', 'geomap-worker.mjs'):
        shutil.copy2(HERE / 'node' / name, root / name)
    write(target, text, crlf)
    for name in ('index.js', 'geomap-isolated.cjs', 'geomap-worker.mjs'):
        subprocess.run(['node', '--check', str(root / name)], check=True)
    note('node.geomapIsolation', True)


def fn_before(text, needle, kind='function '):
    i = text.find(needle)
    if i < 0:
        return None
    j = text.rfind(kind, 0, i)
    m = re.match(re.escape(kind) + r'([\w$]+)\(', text[j:])
    return m.group(1) if m else None


def stream_compat(text):
    marker = '/* vf-custom:stream-compat */'
    if marker in text:
        note('node.streamCompat', True)
        return text
    fingerprints = {
        'concat': r'async function ([\w$]+)\(\{localPaths:[\w$]+,targetPath:[\w$]+,run:[\w$]+=([\w$]+),retryWithReencode:[\w$]+=!1\}\)',
        'dispatch': r'async function ([\w$]+)\(\{jobId:[\w$]+,localPaths:[\w$]+,targetPath:[\w$]+,deps:[\w$]+\}\)',
        'safe': r'async function ([\w$]+)\(\{chunkPaths:[\w$]+,targetPath:[\w$]+,signal:[\w$]+,run:[\w$]+=([\w$]+),emit:[\w$]+=\(\)=>\{\}\}\)',
        'probe': r'async function ([\w$]+)\([\w$]+,[\w$]+=\{\}\)\{let\{stdout:[\w$]+,stderr:[\w$]+\}=await [\w$]+\("ffprobe"',
    }
    names = {k: re.search(v, text) for k, v in fingerprints.items()}
    # The shared ffprobe runner is also identified by the stream inspection call.
    if not names['probe']:
        binary = re.search(r'function ([\w$]+)\(\)\{return process\.env\.VIDFORGE_FFPROBE_PATH\|\|"ffprobe"\}', text)
        matches = list(re.finditer(r'async function ([\w$]+)\(e,t=\{\}\)\{return [\w$]+\(' + re.escape(binary.group(1)) + r'\(\),e,t\)\}', text)) if binary else []
        probe_name = matches[0].group(1) if len(matches) == 1 else None
    else:
        probe_name = names['probe'].group(1)
    if not all(names[k] for k in ('concat', 'dispatch', 'safe')) or not probe_name:
        raise RuntimeError('Required AVC compatibility hook fingerprints missing')
    runner = names['concat'].group(2)
    hooks = []
    for key, paths in [('concat', 'localPaths'), ('dispatch', 'localPaths'), ('safe', 'chunkPaths')]:
        name = names[key].group(1)
        hooks.append(f'{name}=__vfCustom.createCompatibleConcat({name},{{probe:(a,o)=>{probe_name}(a,o),run:(a,o)=>{runner}(a,o),key:"{paths}"}});')
    # In-flight assembly caches from the unsafe join cannot be resumed as valid.
    actual = re.search(r'function ([\w$]+)\(\{chunkPaths:[\w$]+(?:=\[\])?,intake:', text)
    if not actual:
        raise RuntimeError('Required final assembly cache fingerprint missing')
    name = actual.group(1)
    hooks.append(f'{{const o={name};{name}=function(...a){{return "avc-high-contract-v1:"+o.apply(this,a)}};}}')
    note('node.streamCompat', True)
    return text + '\n' + marker + ';(()=>{' + ''.join(hooks) + '__vfCustom.report("streamCompat",true)})();\n'


def sourcing_deadline(text):
    marker = '/* vf-custom:sourcing-deadline */'
    if marker in text:
        note('node.sourcingDeadline', True)
        return text
    matches = list(re.finditer(
        r'function ([\w$]+)\(\{segments:[\w$]+=0,clipvaultSlots:[\w$]+=1,searchSlots:[\w$]+=null,(?:siglipSlots:[\w$]+=null,)?params:[\w$]+=\{\}\}=\{\}\)',
        text,
    ))
    if len(matches) != 1:
        note('node.sourcingDeadline', False, f'{len(matches)} budget fingerprints')
        return text
    name = matches[0].group(1)
    note('node.sourcingDeadline', True)
    return text + (
        f'\n{marker};(()=>{{try{{{name}=__vfCustom.extendSourcingBudget({name});'
        '__vfCustom.report("sourcingDeadline",true)}catch(e){'
        '__vfCustom.report("sourcingDeadline",false,String(e))}})();\n'
    )


def thumbnail_openlux(text):
    marker = '/* vf-custom:thumbnail-openlux */'
    if marker in text:
        note('node.thumbnailOpenlux', True)
        return text
    cli = fn_before(text, 'CLI proxy thumbnail generation failed', 'async function ')
    generate = fn_before(text, 'new Error(`All Nano Banana routes failed:', 'async function ')
    provider = re.search(r'async function ([\w$]+)\(\{route:[\w$]+,prompt:[\w$]+,aspectRatio:', text)
    start = text.find('async function ' + str(cli) + '(')
    end = text.find('async function ', start + len('async function '))
    cli_body = text[start:end]
    credential = re.search(r'let [\w$]+=([\w$]+)\("cliProxy",\{pipelineId:"thumbnails"\}\)', text)
    crop = re.search(r'let [\w$]+=await ([\w$]+)\([\w$]+\);return [\w$]+\(\{step:"thumbnails"', cli_body)
    suffix = re.search(r'prompt:`\$\{[\w$]+\}\$\{([\w$]+)\}`', cli_body)
    sensitive = re.search(r'\?\.noRetry===!0\|\|([\w$]+)\(', cli_body)
    start_generate = text.find('async function ' + str(generate) + '(')
    end_generate = text.find('async function ', start_generate + len('async function '))
    control = re.search(r'if\(([\w$]+)\([\w$]+,\{jobId:[\w$]+,scheduler:([\w$]+)\}\)\)throw', text[start_generate:end_generate])
    if not all([cli, generate, provider, credential, crop, suffix, control, sensitive]):
        note('node.thumbnailOpenlux', False, 'thumbnail/provider fingerprints missing')
        return text
    code = (
        f'const h=__vfCustom.createThumbnailOpenluxHooks({{getCredential:()=>{credential.group(1)}("openlux",{{pipelineId:"thumbnails"}}),'
        f'render:a=>{provider.group(1)}(a),crop:a=>{crop.group(1)}(a),suffix:()=>{suffix.group(1)},'
        f'isControlError:(e,id)=>{control.group(1)}(e,{{jobId:id,scheduler:{control.group(2)}}}),isSensitive:e=>{sensitive.group(1)}(e)}});'
        f'{cli}=h.wrapCli({cli});{generate}=h.wrapGenerate({generate});'
    )
    note('node.thumbnailOpenlux', True)
    return text + f'\n{marker};(()=>{{try{{{code}__vfCustom.report("thumbnailOpenlux",true)}}catch(e){{__vfCustom.report("thumbnailOpenlux",false,String(e))}}}})();\n'


def thumbnail_identity(text):
    marker = '/* vf-custom:thumbnail-subject-identity */'
    if marker in text:
        note('node.thumbnailIdentity', True)
        return text
    contract = json.loads((HERE / 'thumbnail-identity' / 'native-builders.json').read_text())
    functions = contract['functions']
    for definition in functions.values():
        if text.count(definition['source']) != 1:
            note('node.thumbnailIdentity', False, 'native thumbnail builder drift')
            return text
    writer, rewrite, validator = (functions[key]['name'] for key in ('writer', 'rewrite', 'validator'))
    code = (f'const h=__vfCustom.createThumbnailSubjectHooks({{writer:{writer},rewrite:{rewrite},validator:{validator}}});'
            f'{writer}=h.wrapWriter({writer});{rewrite}=h.wrapRewrite({rewrite});{validator}=h.wrapValidator({validator});')
    note('node.thumbnailIdentity', True)
    return text + f'\n{marker};(()=>{{try{{{code}__vfCustom.report("thumbnailIdentity",true)}}catch(e){{__vfCustom.report("thumbnailIdentity",false,String(e))}}}})();\n'


def fish_free(text):
    marker = '/* vf-custom:fish-free */'
    if marker in text:
        note('node.fishFreeModel', True)
        return text
    matches = list(re.finditer(
        r'function ([\w$]+)\(([\w$]+),[\w$]+=Date\.now\(\),[\w$]+=process\.env\)\{let [\w$]+=String\(\2\|\|""\)\.trim\(\),[\w$]+=[\w$]+\.find\([\w$]+=>[\w$]+\.id===[\w$]+\);return [\w$]+\?[\w$]+\.free&&!([\w$]+)\(',
        text,
    ))
    if len(matches) != 1:
        note('node.fishFreeModel', False, f'{len(matches)} Fish normalizer fingerprints')
        return text
    normalizer, available = matches[0].group(1), matches[0].group(3)
    note('node.fishFreeModel', True)
    return text + (
        f'\n{marker};(()=>{{try{{if(__vfCustom.modEnabled("fishFree")){{{normalizer}=__vfCustom.fishFreeModel;'
        f'{available}=__vfCustom.fishFreeAvailable;}}'
        '__vfCustom.report("fishFreeModel",true)}catch(e){'
        '__vfCustom.report("fishFreeModel",false,String(e))}})();\n'
    )


def map_admission(text):
    marker = 'vf-custom:idle-map-reservation'
    if marker in text:
        note('node.mapAdmission', True)
        return text
    check = re.search(r'function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)=\2,([\w$]+)=[\w$]+\(\3\)\)\{let ([\w$]+)=([\w$]+)\(\2\),', text)
    queue = re.search(r'function [\w$]+\(\)\{if\(([\w$]+)\|\|([\w$]+)\.length===0\)return;let [\w$]+=[\w$]+==null\?0:\2\.findIndex', text)
    chooser = re.search(r'function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let [\w$]+=null;for\(let [\w$]+ of \3\.waiters\)', text)
    if not check or not queue or not chooser or '"reservation"' not in text[check.start():check.start() + 750]:
        note('node.mapAdmission', False, 'native render admission fingerprints missing')
        return text
    name, lane, active = check.group(1), check.group(8), queue.group(1)
    hook = (f'\n/* {marker} */;try{{{name}=__vfCustom.wrapMapAdmissionCheck({name},'
            f'()=>({{lane:{lane}("render"),activeMap:{active}}}));'
            f'{chooser.group(1)}=__vfCustom.wrapMapWaiterChoice({chooser.group(1)},(...a)=>{name}(...a));'
            '__vfCustom.report("mapAdmission",true)}catch(e){__vfCustom.report("mapAdmission",false,String(e))}\n')
    note('node.mapAdmission', True)
    return text + hook


def ffmpeg_admission(text):
    marker = 'vf-custom:ready-ffmpeg-reservation-v1'
    if marker in text:
        note('node.ffmpegAdmission', True)
        return text
    check = re.search(
        r'function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)=\2,([\w$]+)=([\w$]+)\(\3\)\)\{let ([\w$]+)=([\w$]+)\(\2\),',
        text,
    )
    if not check or '"reservation"' not in text[check.start():check.start() + 750]:
        raise RuntimeError('Required FFmpeg admission fingerprint missing')
    name, priority, lane = check.group(1), check.group(7), check.group(9)
    hook = (
        f'\n/* {marker} */;try{{{name}=__vfCustom.wrapFfmpegAdmissionCheck({name},'
        f'(jobId,priority)=>({{lane:{lane}("ffmpeg"),priority:priority??{priority}(jobId)}}));'
        '__vfCustom.report("ffmpegAdmission",true)}catch(e){'
        '__vfCustom.report("ffmpegAdmission",false,String(e))}\n'
    )
    note('node.ffmpegAdmission', True)
    return text + hook


def ai33_stt_response(text):
    marker = '/* vf-custom:ai33-stt-envelope-v1 */'
    if marker in text:
        note('node.ai33SttEnvelope', True)
        return text
    anchor = text.find('OpenSpeaker speech-to-text did not return a task_id')
    start = text.rfind('async function ', 0, anchor)
    end = text.find('async function ', start + 15)
    if anchor < 0 or start < 0 or end < 0:
        raise RuntimeError('Required AI33 STT response fingerprint missing')
    pattern = re.compile(
        r'let [\w$]+=String\(([\w$]+)\?\.text\?\?""\),[\w$]+=[\w$]+\(\1\?\.words\);'
    )
    matches = list(pattern.finditer(text, start, end))
    if len(matches) != 1:
        raise RuntimeError('Required AI33 STT transcript parser is not unique')
    match = matches[0]
    result = match.group(1)
    # OpenSpeaker returns a singleton list; do not guess offsets for multiple transcripts.
    unwrap = f'{marker}{result}=__vfCustom.modEnabled("ai33Stt")&&Array.isArray({result})&&{result}.length===1?{result}[0]:{result};'
    note('node.ai33SttEnvelope', True)
    return text[:match.start()] + unwrap + text[match.start():]


def node():
    bundle = DIST / 'index.mjs'
    text, crlf = read(bundle)
    target = DIST / 'vf-custom'
    previous = None
    if MARK + ':hooks' in text:
        previous = HOOK_GATE['parse_hook_report']((target / 'hooks-build.json').read_bytes())
        HOOK_GATE['validate_hook_report'](previous)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(HERE / 'node', target)
    if MARK + ':hooks' in text:
        if previous is not None:
            report.update({**previous['report'], **report})
        text = long_assembly(ffmpeg_admission(ai33_stt_response(map_admission(stream_compat(fish_free(thumbnail_openlux(sourcing_deadline(text))))))))
        text = gpu_render_events(text)
        text = _home_install.patch_node(text)
        text = _memory_install.patch_node(text)
        text = _fs_limit_install.patch_node(text)
        text = _capacity_install.patch_node(text)
        text = _priority_install.patch_node(text)
        text = _route_install.patch_node(text)
        text = _wordsync_install.patch_node(text)
        text = _broll_install.patch_node(text)
        text = _proc_install.patch_node(text)
        note('node.homeQueue', True)
        write(bundle, text, crlf)
        note('node.bundle', True, 'already patched')
        (target / 'hooks-build.json').write_text(json.dumps({
            **(previous or {}), 'report': report,
        }, indent=1))
        return
    found = {}
    m = re.search(r'function ([\w$]+)\(([\w$]+),([\w$]+)=([\w$]+)\(\)\)\{return \2==="gpuFfmpeg"\?', text) \
        or re.search(r'function ([\w$]+)\(([\w$]+),([\w$]+)=([\w$]+)\(\)\)\{return \2==="search"\?', text)
    if m:
        found['lane'], found['limits'] = m.group(1), m.group(4)
    m = re.search(r'function ([\w$]+)\(\)\{[\w$]+\|\|\([\w$]+=!0,queueMicrotask\(\(\)=>\{[\w$]+=!1,[\w$]+\.emit\("slots"\)\}\)\)\}', text)
    if m:
        found['wake'] = m.group(1)
    found['workerTarget'] = fn_before(text, 'throw new Error("FFmpeg concurrency must be a positive safe integer")')
    found['engineSync'] = fn_before(text, '[engine-concurrency] search=', 'async function ')
    m = re.search(r'([\w$]+)=Object\.freeze\(\{source_clip:Object\.freeze\(\[', text)
    if m:
        found['fallbacks'] = m.group(1)
    m = re.search(r'siglip:([\w$]+)\.request\("/internal/concurrency"', text)
    if m:
        found['siglipClient'] = m.group(1)
    m = re.search(r'([\w$]+)\.request\("/v1/internal/ffmpeg-runtime"', text)
    if m:
        found['fflowClient'] = m.group(1)
    m = re.search(r'([\w$]+)\.use\("/api/license",', text)
    app = m.group(1) if m else None
    m = re.search(r'function ([\w$]+)\([\w$]+,[\w$]+,[\w$]+\)\{return [\w$]+\.authUser\?\.role==="owner"\?[\w$]+\(\):[\w$]+\.status\(403\)', text)
    owner = m.group(1) if m else None
    m = re.search(r'([\w$]+)\.prepare\("DELETE FROM queue_jobs WHERE id = \?"\)', text)
    db = m.group(1) if m else None
    print('[vf-custom] fingerprints:', json.dumps({**found, 'app': app, 'owner': owner, 'db': db}))

    text = 'import * as __vfCustom from "./vf-custom/custom.mjs";\n' + text
    if app and owner and db and text.count(f'{app}.use("/api/license",') == 1:
        text = text.replace(f'{app}.use("/api/license",',
                            f'/* {MARK}:install */try{{__vfCustom.installCustom({{app:{app},db:{db},requireOwner:{owner}}})}}catch(__e){{console.error("[vf-custom] install failed",__e)}}{app}.use("/api/license",')
        note('node.routes', True)
    else:
        note('node.routes', False, 'app/db/owner fingerprint missing')

    # Max active videos: start gate in the queue's "queued -> running" UPDATE, overflow back to the
    # queue before the restart-resume pass, re-dispatch when the limit changes.
    gate = re.compile(r"(WHERE id = @id AND status = 'queued'\s+AND \(available_at IS NULL OR available_at <= @started_at\))`")
    if len(gate.findall(text)) == 1:
        text = gate.sub(lambda m: m.group(1) + "\n       AND ${__vfCustom.modEnabled('queueLimit') ? \"(SELECT COUNT(*) FROM queue_jobs WHERE status IN ('running', 'pausing')) < \" + __vfCustom.maxActiveVideos() : \"1=1\"}`", text)
        note('node.maxActiveGate', True)
    else:
        note('node.maxActiveGate', False, 'queue start statement not found')
    m = re.search(r'([\w$]+)\.prepare\("UPDATE queue_jobs SET status = \'paused\', updated_at = \? WHERE status = \'pausing\'"\)', text)
    if m and text.count(m.group(0)) == 1:
        text = text.replace(m.group(0), f'(__vfCustom.demoteOverflow({m.group(1)}),{m.group(0)})')
        note('node.maxActiveRestart', True)
    else:
        note('node.maxActiveRestart', False, 'restart resume pass not found')
    m = re.search(r'dispatchQueuedJobs:\(\)=>([\w$]+)', text)
    found['dispatch'] = m.group(1) if m else None

    # Surplus retries: per-spec attempt loop right after the circuit-breaker skip of the LLM chain.
    m = re.search(r'if\(!([\w$]+)\(([\w$]+)\)\)\{[\w$]+\(\2,"circuit_open"\)', text)
    loop = re.compile(r'for\(let ([\w$]+)=0;\1<([\w$]+);\1\+=1\)')
    n = loop.search(text, m.end()) if m else None
    if m and n and n.start() - m.end() < 600:
        counter, limit, spec = n.group(1), n.group(2), m.group(2)
        replacement = f'const __vfLim={limit};for(let {counter}=0,{limit}=__vfCustom.llmAttempts({spec},__vfLim);{counter}<{limit};{counter}+=1)'
        text = text[:n.start()] + replacement + text[n.end():]
        found['breaker'] = m.group(1)
        note('node.surplusRetries', True)
        # Pause between Surplus attempts: our own window (stock: 1 s / 3 s / 10 s).
        wait = re.compile(r'if\(' + re.escape(counter) + r'<' + re.escape(limit) + r'-1&&([\w$]+)\(' + re.escape(spec) + r'\)\)await ([\w$]+)\(([\w$]+),([\w$]+)\(([\w$]+),' + re.escape(counter) + r',([\w$]+)\)\)')
        w8 = wait.search(text, n.start())
        if w8 and w8.start() - n.start() < 6000:
            old = w8.group(0)
            new = old.replace(f'{w8.group(4)}({w8.group(5)},{counter},{w8.group(6)})', f'__vfCustom.retryDelay({spec},{w8.group(4)}({w8.group(5)},{counter},{w8.group(6)}),{w8.group(5)})')
            text = text[:w8.start()] + new + text[w8.end():]
            note('node.surplusWait', True)
        else:
            note('node.surplusWait', False, 'retry pause not found')
    else:
        note('node.surplusRetries', False, 'LLM attempt loop not found')

    # Surplus first: after the stock chain is final (route + user pin), move the Surplus leg to the front.
    pin = re.compile(r'let ([\w$]+)=[\w$]+\(([\w$]+)\|\|[\w$]+\);\1&&\(([\w$]+)=[\w$]+\(\3,\1\)\),(?=\2&&!\3\.some\()')
    hits = pin.findall(text)
    m = pin.search(text)
    vid = None
    if m:
        vids = list(re.finditer(r'let ([\w$]+)=[\w$]+\.some\(\$=>\$\?\.mediaType==="video"', text[max(0, m.start() - 3000):m.start()]))
        vid = vids[-1].group(1) if vids else None
    if len(hits) == 1 and vid:
        w, route, chain = m.group(1), m.group(2), m.group(3)
        window = text[max(0, m.start() - 3000):m.start()]
        pipes = re.findall(r'([\w$]+)==="vision"&&\(' + re.escape(chain) + r'=' + re.escape(chain) + r'\.filter\(', window)
        pipe = pipes[-1] if pipes else 'void 0'
        text = text[:m.end()] + f'{w}||({chain}=__vfCustom.surplusFirst({chain},{route},{vid},{pipe})),' + text[m.end():]
        note('node.surplusFirst', True)
    else:
        note('node.surplusFirst', False, f'chain pin point not found ({len(hits)} hits, video={vid})')

    # Surplus market check (shared cached promise in front of every Surplus call): hard time limit.
    m = re.search(r'async function ([\w$]+)\(\{model:([\w$]+)=[\w$]+,fetchImpl:[\w$]+=[\w$]+\(\),now:[\w$]+=Date\.now\(\),timeoutMs:[\w$]+=[\w$]+\}=\{\}\)\{let ([\w$]+)=([\w$]+)\.get\(\2\);if\(\3\?\.promise\)return \3\.promise;', text)
    if m:
        found['marketCheck'], found['marketCache'] = m.group(1), m.group(4)
    # Chunk composition entry (stages inputs, submits /v1/render, polls): re-stage when an input vanished.
    m = re.search(r'async function ([\w$]+)\(\{payload:[\w$]+,targetPath:[\w$]+,jobId:[\w$]+,chunkId:([\w$]+),contentSeconds:[\w$]+,checkpoint:[\w$]+\}\)\{return [\w$]+\([\w$]+,`Chunk \$\{\2\|\|""\} composition`', text)
    if m:
        found['restage'] = m.group(1)
    # Contact sheet extraction (+ its ffmpeg probe, ffmpeg runner, timestamps, cell size) and the frame-set helper.
    m = re.search(r'async function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)=\{\}\)\{if\(!await\(\4\.ffmpegAvailable\|\|([\w$]+)\)\(\)\)return null;let [\w$]+=\4\.runFfmpeg\|\|([\w$]+),', text)
    if m:
        body = text[m.end():m.end() + 1500]
        dims = re.search(r'scale=\$\{([\w$]+)\}:\$\{([\w$]+)\}:force_original_aspect_ratio=decrease', body)
        stamps = re.search(r'[,;]([\w$]+)=([\w$]+)\(' + re.escape(m.group(3)) + r'\),[\w$]+=\1\.map\(', body)
        frames = re.search(r'return ([\w$]+)\([\w$]+,[\w$]+\)\}async function ' + re.escape(m.group(1)) + r'\(', text[max(0, m.start() - 400):m.end()])
        if dims and stamps:
            found['sheet'], found['probe'], found['ffrun'] = m.group(1), m.group(5), m.group(6)
            found['sheetW'], found['sheetH'], found['sheetTimes'] = dims.group(1), dims.group(2), stamps.group(2)
            found['frameSet'] = frames.group(1) if frames else None
    m = re.search(r'([\w$]+)\.request\("/api/download",', text)
    if m:
        found['clipvaultClient'] = m.group(1)
    # Stock "Retry" of a failed queue job (resumes saved work).
    m = re.search(r'\.post\("/:id/retry",[\w$]+\("create"\),async\(([\w$]+),[\w$]+\)=>\{try\{let [\w$]+=await ([\w$]+)\(\1\.params\.id\)', text)
    if m:
        found['retryJob'] = m.group(2)

    tail = [f'\n/* {MARK}:hooks */;(()=>{{const c=__vfCustom;']
    if found.get('breaker'):
        tail.append(f'try{{const o={found["breaker"]};{found["breaker"]}=function(e,t){{return c.breakerAllows(e,o.apply(this,arguments))}};c.report("surplusBreaker",true)}}catch(e){{c.report("surplusBreaker",false,String(e))}}')
    if found.get('dispatch'):
        tail.append(f'try{{globalThis.__vfDispatchQueued=()=>{{try{{Promise.resolve({found["dispatch"]}()).catch(()=>{{}})}}catch{{}}}}}}catch{{}}')
    def wrap(key, code):
        name = found.get(key)
        if not name:
            note('node.' + key, False, 'fingerprint missing')
            tail.append(f'c.report("{key}",false,"fingerprint missing");')
            return
        tail.append(f'try{{{code.format(n=name, **found)}c.report("{key}",true)}}catch(e){{c.report("{key}",false,String(e))}}')
        note('node.' + key, True)
    wrap('lane', 'const o={n};{n}=function(e,t){{return c.laneSize(e,o.apply(this,arguments))}};')
    wrap('workerTarget', 'const o={n};{n}=function(v){{return o.call(this,c.workerTarget(v))}};')
    wrap('engineSync', 'const o={n};{n}=function(e){{return o.call(this,c.engineLimits(e))}};')
    wrap('wake', 'globalThis.__vfPcBoostWake=()=>{{if(c.modEnabled("serverBoost"))try{{{n}()}}catch{{}}}};')
    wrap('restage', '{n}=c.wrapComposition({n});')
    if found.get('sheet'):
        fs_get = f'getFrames:()=>{found["frameSet"]},setFrames:v=>{{{found["frameSet"]}=v}},' if found.get('frameSet') else ''
        tail.append(f'try{{c.installSheetBatch({{getSheet:()=>{found["sheet"]},setSheet:v=>{{{found["sheet"]}=v}},getProbe:()=>{found["probe"]},setProbe:v=>{{{found["probe"]}=v}},{fs_get}run:a=>{found["ffrun"]}(a),times:t=>{found["sheetTimes"]}(t),width:()=>{found["sheetW"]},height:()=>{found["sheetH"]}}})}}catch(e){{c.report("sheetBatch",false,String(e))}}')
        note('node.sheetBatch', True)
    else:
        note('node.sheetBatch', False, 'contact sheet fingerprint missing')
    clients = [(k, found.get(v)) for k, v in (('fflow', 'fflowClient'), ('clipvault', 'clipvaultClient'), ('siglip', 'siglipClient')) if found.get(v)]
    if clients:
        tail.append('try{c.installEngineRetry([' + ','.join(f'["{k}",()=>{v}]' for k, v in clients) + '])}catch(e){c.report("engineRetry",false,String(e))}')
        note('node.engineRetry', True)
    else:
        note('node.engineRetry', False, 'engine client fingerprints missing')
    found['marketGuard'] = found.get('marketCheck') if found.get('marketCache') else None
    wrap('marketGuard', '{n}=c.wrapMarketCheck({n},()=>{marketCache});')
    if found.get('retryJob'):
        tail.append(f'try{{c.installAutoRetry(id=>{found["retryJob"]}(id))}}catch(e){{c.report("autoRetry",false,String(e))}}')
        note('node.autoRetry', True)
    else:
        note('node.autoRetry', False, 'stock retry fingerprint missing')
        tail.append('c.report("autoRetry",false,"fingerprint missing");')
    if found.get('engineSync') and found.get('limits'):
        tail.append(f'try{{globalThis.__vfPcBoostOnExtra=()=>{{if(c.modEnabled("serverBoost"))try{{Promise.resolve({found["engineSync"]}({found["limits"]}())).catch(()=>{{}})}}catch{{}}}};c.report("resync",true)}}catch(e){{c.report("resync",false,String(e))}}')
    if found.get('fallbacks'):
        tail.append(f'try{{c.installFallbacks(()=>{found["fallbacks"]},v=>{{{found["fallbacks"]}=v}})}}catch(e){{c.report("fallbacks",false,String(e))}}')
        note('node.fallbacks', True)
    else:
        note('node.fallbacks', False, 'fallback map fingerprint missing')
    if found.get('siglipClient') and found.get('fflowClient'):
        tail.append(f'try{{c.installSiglip(()=>{found["siglipClient"]},()=>{found["fflowClient"]})}}catch(e){{c.report("siglipPc",false,String(e))}}')
        note('node.siglipPc', True)
    else:
        note('node.siglipPc', False, 'SigLIP or FFlow client fingerprint missing')
    tail.append('})();\n')
    text = long_assembly(_home_install.patch_node(gpu_render_events(ffmpeg_admission(ai33_stt_response(map_admission(stream_compat(fish_free(thumbnail_identity(thumbnail_openlux(sourcing_deadline(text + ''.join(tail))))))))))))
    note('node.homeQueue', True)
    text = _memory_install.patch_node(text)
    text = _fs_limit_install.patch_node(text)
    text = _capacity_install.patch_node(text)
    text = _priority_install.patch_node(text)
    text = _route_install.patch_node(text)
    text = _wordsync_install.patch_node(text)
    text = _broll_install.patch_node(text)
    text = _proc_install.patch_node(text)
    write(bundle, text, crlf)
    (target / 'hooks-build.json').write_text(json.dumps({'fingerprints': {**found, 'app': app, 'owner': owner, 'db': db}, 'report': report}, indent=1))


# ---------------------------------------------------------------- UI
def gpu_render_events(text):
    marker = 'vf-custom:gpu-render-events-v1'
    if marker in text:
        note('node.gpuRenderEvents', True)
        return text
    pattern = re.compile(r'function ([\w$]+)\(\{jobId:[^{}]{1,500}\}=\{\}\)\{.{0,4000}?return ([\w$]+)\.emit\("event",', re.S)
    matches = [m for m in pattern.finditer(text) if 'INSERT INTO events' in text[m.start():m.end()+5000]]
    if len(matches) != 1:
        note('node.gpuRenderEvents', False, 'native event bus fingerprint missing or ambiguous')
        return text
    emit, bus = matches[0].groups()
    note('node.gpuRenderEvents', True)
    hook = '__vfCustom.installGpuRenderEvents({getEmitter:()=>'+bus+',emit:'+emit+'})'
    return text + '\n/* '+marker+' */;try{'+hook+'}catch(e){__vfCustom.report("gpuRenderEvents",false,String(e))}\n'


def ui():
    assets = PUBLIC / 'assets'
    for f in (HERE / 'ui').iterdir():
        shutil.copy2(f, assets / f.name)
    index = PUBLIC / 'index.html'
    text, crlf = read(index)
    if MARK not in text and '</head>' in text:
        tags = ('    <!-- vf-custom -->\n'
                '    <link rel="stylesheet" href="/assets/pc-boost-settings-20261002.css?v=bandwidth25-20261011b">\n'
                '    <script type="module" src="/assets/pc-boost-settings-20261002.js?v=motion-settings-20261017a"></script>\n'
                '    <link rel="stylesheet" href="/assets/pc-transfer-settings-20261011.css?v=size-20261011b">\n'
                '    <script type="module" src="/assets/pc-transfer-settings-20261011.js?v=size-nvenc-20261013a"></script>\n'
                '    <script type="module" src="/assets/vf-custom-tab.js?v=vfc1"></script>\n')
        text = text.replace('</head>', tags + '</head>', 1)
        write(index, text, crlf)
        note('ui.inject', True)
    else:
        if MARK in text and '</head>' in text:
            for extension in ('js', 'css'):
                text = re.sub(
                    rf'(/assets/pc-boost-settings-20261002\.{extension})\?v=[^"\s]+',
                    r'\1?v=motion-settings-20261017a' if extension == 'js' else r'\1?v=bandwidth25-20261011b', text)
            additions = ''
            for extension in ('js', 'css'):
                text = re.sub(
                    rf'(/assets/pc-transfer-settings-20261011\.{extension})\?v=[^"\s]+',
                    r'\1?v=size-nvenc-20261013a' if extension == 'js' else r'\1?v=size-20261011b', text)
            if '/assets/pc-transfer-settings-20261011.css' not in text:
                additions += '    <link rel="stylesheet" href="/assets/pc-transfer-settings-20261011.css?v=size-20261011b">\n'
            if '/assets/pc-transfer-settings-20261011.js' not in text:
                additions += '    <script type="module" src="/assets/pc-transfer-settings-20261011.js?v=size-nvenc-20261013a"></script>\n'
            text = text.replace('</head>', additions + '</head>', 1)
            write(index, text, crlf)
        note('ui.inject', MARK in text, 'no </head>')


if __name__ == '__main__':
    graphics()
    geomap_isolation()
    fflow()
    node()
    ui()
    subprocess.run(['node', str(HERE / 'eta-display' / 'installer.cjs'), str(DIST / 'index.mjs')], check=True)
    note('node.etaDisplay', True)
    subprocess.run(['node', str(HERE / 'infographic-timeline' / 'child-installer.cjs'),
                    '--root', str(DIST.parent.parent), '--apply'], check=True)
    note('render.infographicTimeline', True)
    # Chart headings never wait for the spoken-text gate. Then rebuild the Remotion
    # prebundle: any patched source (incl. the timeline patch above) makes the baked
    # bundle stale and every render would bundle webpack again.
    subprocess.run(['node', str(HERE / 'remotion-heading' / 'installer.cjs'),
                    '--root', str(DIST.parent.parent), '--apply', '--prebundle'], check=True)
    _route_install.patch_library(FRAMESHIFT_LIB)
    checks = [['node', '--check', str(FRAMESHIFT_LIB / name)] for name in _route_install.LIBRARY] + [['node', '--check', str(DIST / 'index.mjs')]] + [['node', '--check', str(p)] for p in (DIST / 'vf-custom').glob('*.mjs')] \
        + [[sys.executable, '-m', 'py_compile', str(CORE / 'ffmpeg.py'), str(ROUTES), str(CORE / 'pc_ffmpeg_hook.py'), str(CORE / 'pc_scene_hook.py'), str(CORE / 'pc_ffmpeg_protocol.py'), str(CORE / 'pc_transfer_limits.py')]]
    for check in checks:
        subprocess.run(check, check=True)
    (DIST / 'vf-custom' / 'hooks-build.json').write_text(json.dumps({**json.loads((DIST / 'vf-custom' / 'hooks-build.json').read_text()), 'report': report}, indent=1))
    subprocess.run([sys.executable, str(HERE / 'validate-hook-report.py'),
                    str(DIST / 'vf-custom' / 'hooks-build.json')], check=True)
    print('[vf-custom] done:', json.dumps(report))
    sys.exit(0)
