"""GPU-only closed native media recipes; native execution remains owned by Node."""
import asyncio
from contextlib import contextmanager, redirect_stdout
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from pc_node_normalize_cli import decode_request, run_request, _load_hook, GPU_POLICY
from pc_node_media_recipes import classify_argv


def _path(value, root, source=False):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Absolute project path required')
    resolved = path.resolve(strict=source)
    resolved.relative_to(root)
    cursor = path
    while cursor != cursor.parent and cursor != root.parent:
        if cursor.is_symlink():
            raise ValueError('Symlink media unsupported')
        cursor = cursor.parent
    if not path.parent.is_dir() or ((source or path.exists()) and not path.is_file()):
        raise ValueError('Regular project media required')
    return resolved


def probe_media(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-threads', '1',
        '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,time_base,duration:format=duration',
        '-of', 'json', str(path)], capture_output=True, timeout=15, check=True)
    return json.loads(result.stdout)


def qualify(request, *, probe=probe_media, classify=classify_argv):
    if not isinstance(request, dict) or set(request) != {'argv', 'options'}:
        raise ValueError('Exact request required')
    args, options = request['argv'], request['options']
    if not isinstance(args, list) or not args or not all(isinstance(x, str) for x in args):
        raise ValueError('Invalid argv')
    kind = classify(args)
    if not kind or not isinstance(options, dict) or set(options) != {'timeoutMs'}:
        raise ValueError('Unknown recipe')
    if type(options['timeoutMs']) is not int or not 1 <= options['timeoutMs'] <= 600000:
        raise ValueError('Invalid deadline')
    data = Path(os.environ.get('DATA_DIR', '/data'))
    if not data.is_absolute() or '..' in data.parts or (data / 'projects').is_symlink():
        raise ValueError('Invalid project root')
    root = (data / 'projects').resolve(strict=True)
    output = _path(args[-1], root)
    if output.suffix.lower() != '.mp4':
        raise ValueError('MP4 output required')
    inputs = [_path(args[i + 1], root, True) for i, arg in enumerate(args[:-1]) if arg == '-i']
    if not inputs or any(p == output or (output.exists() and os.path.samefile(p, output)) for p in inputs):
        raise ValueError('Input/output collision')
    if kind == 'broll-simpleimage':
        duration = float(args[args.index('-t') + 1])
    else:
        media = probe(inputs[0])
        videos = [s for s in media.get('streams', []) if s.get('codec_type') == 'video']
        if len(videos) != 1:
            raise ValueError('Single video stream required')
        video = videos[0]
        if any(video.get(key) != expected for key, expected in {
            'codec_name': 'h264', 'pix_fmt': 'yuv420p', 'width': 1920, 'height': 1080,
            'r_frame_rate': '24/1', 'avg_frame_rate': '24/1', 'time_base': '1/12288'}.items()):
            raise ValueError('Source outside qualified High24 clock')
        duration = float(video.get('duration') or media.get('format', {}).get('duration', 'nan'))
    if not math.isfinite(duration) or not .05 <= duration <= 600:
        raise ValueError('Unsupported duration')
    remote = list(args)
    # Make only already-proven output defaults explicit for the NVENC policy.
    extra = []
    for flag, value in [('-r', '24'), ('-pix_fmt', 'yuv420p'), ('-crf', '18')]:
        if flag not in remote:
            extra.extend([flag, value])
    remote[-1:-1] = extra
    return {'argv': remote, 'root': root, 'output': output, 'duration': duration, 'kind': kind}


@contextmanager
def gpu_only_transport(hook):
    original_http, original_selector = hook.http_request, hook.select_gpu_policy

    def select(payload, output, health):
        if (health.get('protocolVersion', 1) < 2 or not health.get('nvencReady')
                or health.get('gpuBusy', 0) >= health.get('gpuCapacity', 0)):
            raise RuntimeError('GPU unavailable')
        payload['gpuPolicy'] = GPU_POLICY

    def http(url, token, method, path, data=None, timeout=5):
        result = original_http(url, token, method, path, data, timeout)
        if method == 'POST' and path == '/renders' and result.get('lane') != 'gpu':
            identifier = result.get('id')
            if isinstance(identifier, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', identifier):
                original_http(url, token, 'DELETE', '/renders/' + identifier, None, 5)
            raise RuntimeError('CPU overflow rejected')
        if method == 'GET' and path.startswith('/renders/') and result.get('state') == 'done':
            if result.get('gpuPolicy') != GPU_POLICY or result.get('lane') != 'gpu':
                raise RuntimeError('Unverified GPU result')
        return result

    hook.http_request, hook.select_gpu_policy = http, select
    try:
        yield
    finally:
        hook.http_request, hook.select_gpu_policy = original_http, original_selector


async def offload(request, *, hook=None, probe=probe_media, classify=classify_argv):
    try:
        recipe = qualify(request, probe=probe, classify=classify)
    except (ValueError, OSError, TypeError, subprocess.SubprocessError):
        return {'offloaded': False, 'metadata': {'reason': 'not_eligible'}}
    hook = hook or _load_hook()
    started = time.monotonic()
    with gpu_only_transport(hook):
        result = await hook.try_offload(['ffmpeg', *recipe['argv']], roots=[recipe['root']],
            timeout=180, expected_duration=recipe['duration'])
    if result != (0, 'PC boost gpu output verified') or not recipe['output'].is_file():
        return {'offloaded': False, 'metadata': {'reason': 'unavailable'}}
    return {'offloaded': True, 'metadata': {'verified': True, 'lane': 'gpu',
        'gpuPolicy': GPU_POLICY, 'recipe': recipe['kind'], 'expectedDuration': recipe['duration'],
        'elapsedMs': round((time.monotonic() - started) * 1000)}}


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError('One payload required')
        request = decode_request(sys.argv[1])
        with redirect_stdout(sys.stderr):
            result = asyncio.run(run_request(request, attempt=offload))
    except Exception as exc:
        result = {'offloaded': False, 'metadata': {'reason': 'unavailable', 'errorType': type(exc).__name__}}
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
