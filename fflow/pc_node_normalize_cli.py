"""Offload only the closed native Node b-roll normalization recipe; never encode locally."""
import asyncio
import base64
import binascii
from contextlib import redirect_stdout
import json
import logging
import os
from pathlib import Path
import re
import signal
import sys
import time

MAX_JSON_BYTES = 65536
MAX_BASE64_CHARS = 131072
DEADLINE_SECONDS = 180
SOURCE_PROBE_SECONDS = 5
GPU_POLICY = 'nvenc-high-qp14-v1'
NORMALIZE_FILTER = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080'
NATIVE_FILTER = re.compile(r'(?:crop=[1-9][0-9]{0,4}:[1-9][0-9]{0,4}:[0-9]{1,5}:[0-9]{1,5},)?'
                           + re.escape(NORMALIZE_FILTER))
FIXED = {0:'-y', 1:'-i', 3:'-vf', 5:'-map', 6:'0:v:0', 7:'-map', 8:'0:a?',
         9:'-c:v', 10:'libx264', 11:'-crf', 13:'-pix_fmt', 14:'yuv420p',
         15:'-r', 16:'24', 17:'-c:a', 18:'aac', 19:'-b:a', 20:'192k',
         21:'-t', 23:'-movflags', 24:'+faststart'}


def _record(reason, **metadata):
    return {'offloaded': False, 'metadata': {'reason': reason, **metadata}}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def decode_request(encoded):
    if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_BASE64_CHARS:
        raise ValueError('Invalid payload size')
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError('Invalid payload size')
        result = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_object)
    except (binascii.Error, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError('Invalid base64 JSON') from exc
    if not isinstance(result, dict):
        raise ValueError('Object required')
    return result


def _path(value, root, *, source=False):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or path.suffix.lower() != '.mp4':
        raise ValueError('Only absolute project MP4 paths supported')
    resolved = path.resolve(strict=source)
    relative = resolved.relative_to(root)
    if not relative.parts or not path.parent.is_dir():
        raise ValueError('Regular project media path required')
    # Reject symlinks even when they happen to resolve back into the project root.
    cursor = path
    while cursor != cursor.parent and cursor != root.parent:
        if cursor.is_symlink():
            raise ValueError('Symlink media paths are not supported')
        cursor = cursor.parent
    if (source or path.exists()) and not path.is_file():
        raise ValueError('Regular media file required')
    return resolved


def qualify(request):
    if not isinstance(request, dict) or set(request) != {'argv','options'}:
        raise ValueError('Exact argv/options payload required')
    argv, options = request['argv'], request['options']
    if (not isinstance(argv, list) or len(argv) != 26 or
            not all(isinstance(x, str) and len(x) <= 32768 and
                    not any(c in x for c in ('\x00','\r','\n')) for x in argv)):
        raise ValueError('Exact native normalization argv required')
    if any(argv[index] != value for index, value in FIXED.items()):
        raise ValueError('Unsupported normalization recipe')
    if not re.fullmatch(r'(?:[0-9]|[1-4][0-9]|5[01])', argv[12]):
        raise ValueError('Native integer CRF required')
    if not re.fullmatch(r'(?:0|[1-9][0-9]{0,5})\.[0-9]{3}', argv[22]) or float(argv[22]) < .05:
        raise ValueError('Native fixed-three-decimal duration required')
    if (not isinstance(options, dict) or set(options) != {'timeoutMs'} or
            type(options['timeoutMs']) is not int or options['timeoutMs'] != 180000):
        raise ValueError('Native 180-second timeout required')
    try:
        from .pc_ffmpeg_protocol import validate_filter, parse_native_credit_filter
    except ImportError:
        from pc_ffmpeg_protocol import validate_filter, parse_native_credit_filter
    credit=parse_native_credit_filter(argv[4])
    if not credit:
        if not NATIVE_FILTER.fullmatch(argv[4]):
            raise ValueError('Only native normalization or exact credit overlay supported')
        validate_filter(argv[4])
    data_dir = Path(os.environ.get('DATA_DIR', '/data'))
    if not data_dir.is_absolute() or '..' in data_dir.parts:
        raise ValueError('Absolute DATA_DIR required')
    projects = data_dir / 'projects'
    if projects.is_symlink():
        raise ValueError('Projects root must not be a symlink')
    root = projects.resolve(strict=True)
    source = _path(argv[2], root, source=True)
    output = _path(argv[-1], root)
    if credit:
        text_path=Path(credit['text_path'])
        expected=Path(str(output)+'.credit.txt')
        if text_path != expected or text_path.is_symlink() or not text_path.is_file():
            raise ValueError('Credit text must belong to this exact output')
        text_path.resolve(strict=True).relative_to(root)
        if not 0 < text_path.stat().st_size <= 65536:
            raise ValueError('Credit text size outside native limits')
    if source == output or (output.exists() and os.path.samefile(source, output)):
        raise ValueError('Input/output collision')
    return {'argv': list(argv), 'root': root, 'output': output,
            'duration': float(argv[22])}


def _load_hook():
    try:
        from . import pc_ffmpeg_hook
    except ImportError:
        import pc_ffmpeg_hook
    return pc_ffmpeg_hook


async def probe_video_source(path):
    # Metadata only: never decode/encode here or spend Home GPU/CPU permits on audio-only MP4s.
    process = await asyncio.create_subprocess_exec(
        'ffprobe', '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file',
        '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'json', str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), SOURCE_PROBE_SECONDS)
        if process.returncode != 0:
            raise ValueError('Source probe failed')
        media = json.loads(stdout)
        if not isinstance(media, dict) or not isinstance(media.get('streams'), list):
            raise ValueError('Invalid source probe')
        return any(isinstance(stream, dict) and stream.get('codec_type') == 'video'
                   for stream in media['streams'])
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()


async def offload(request, *, hook=None):
    try:
        recipe = qualify(request)
    except (ValueError, OSError, TypeError):
        return _record('not_eligible')
    try:
        if not await probe_video_source(recipe['argv'][2]):
            return _record('source_no_video')
    except (OSError, ValueError, asyncio.TimeoutError):
        return _record('source_probe_unavailable')
    hook = hook or _load_hook()
    original_selector = hook.select_gpu_policy
    policy = None

    def scoped_policy(payload, output, health):
        nonlocal policy
        if Path(output).resolve() != recipe['output']:
            raise ValueError('Unexpected normalization output')
        original_selector(payload, output, health)
        if (health.get('gpuEncodingOnly') is True or
                (health.get('nvencReady') is True and health.get('gpuMode') == GPU_POLICY)):
            payload['gpuPolicy'] = GPU_POLICY
            policy = GPU_POLICY

    # This CLI owns one request in one process. The existing hook keeps all caps,
    # authenticated transport, validation and DELETE cleanup; only owned policy expands.
    hook.select_gpu_policy = scoped_policy
    started = time.monotonic()
    try:
        result = await hook.try_offload(['ffmpeg', *recipe['argv']],
                                       roots=[recipe['root']], timeout=DEADLINE_SECONDS,
                                       expected_duration=recipe['duration'])
    finally:
        hook.select_gpu_policy = original_selector
    if (not isinstance(result, tuple) or len(result) != 2 or
            type(result[0]) is not int or result[0] != 0 or not isinstance(result[1], str)):
        return _record('unavailable')
    match = re.fullmatch(r'PC boost (gpu|cpu) output verified', result[1])
    if not match or not recipe['output'].is_file() or (match[1] == 'gpu' and policy != GPU_POLICY):
        return _record('unverified')
    return {'offloaded': True, 'metadata': {
        'verified': True, 'lane': match[1], 'gpuPolicy': policy,
        'expectedDuration': recipe['duration'],
        'elapsedMs': round((time.monotonic()-started)*1000)}}


async def run_request(request, *, attempt=offload, timeout=DEADLINE_SECONDS):
    loop = asyncio.get_running_loop()
    task = asyncio.create_task(attempt(request))
    installed = []
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, task.cancel)
            installed.append(sig)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        return await asyncio.wait_for(task, timeout=min(timeout, DEADLINE_SECONDS))
    except asyncio.TimeoutError:
        return _record('timeout')
    except asyncio.CancelledError:
        return _record('cancelled')
    except Exception as exc:
        return _record('unavailable', errorType=type(exc).__name__)
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        for sig in installed:
            loop.remove_signal_handler(sig)


def main(arguments=None):
    args = sys.argv[1:] if arguments is None else arguments
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    try:
        if len(args) != 1:
            raise ValueError('One base64 argument required')
        request = decode_request(args[0])
        with redirect_stdout(sys.stderr):
            result = asyncio.run(run_request(request))
    except (ValueError, TypeError):
        result = _record('invalid_payload')
    except KeyboardInterrupt:
        result = _record('cancelled')
    except Exception as exc:
        result = _record('unavailable', errorType=type(exc).__name__)
    print(json.dumps(result, separators=(',',':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
