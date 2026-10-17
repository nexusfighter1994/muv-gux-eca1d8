"""Optional FFlow executor hook. Any remote failure returns None for native fallback."""
import asyncio
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import http.client
import urllib.error
import urllib.request
from urllib.parse import urlsplit

try:
    from .mod_flags import mod_enabled
    from .pc_ffmpeg_protocol import MAX_BODY, MAX_INPUT, MAX_TOTAL, MAX_OUTPUT, validate_argv
    from .pc_ffmpeg_protocol import (CREDIT_ASSETS_VERSION, parse_native_credit_filter,
                                     prepare_credit_filter, read_credit_asset)
    from .pc_transfer_limits import read_limits as read_transfer_limits, check_render_sizes, worker_allows_render
except ImportError:
    from mod_flags import mod_enabled
    from pc_ffmpeg_protocol import MAX_BODY, MAX_INPUT, MAX_TOTAL, MAX_OUTPUT, validate_argv
    from pc_ffmpeg_protocol import (CREDIT_ASSETS_VERSION, parse_native_credit_filter,
                                    prepare_credit_filter, read_credit_asset)
    from pc_transfer_limits import read_limits as read_transfer_limits, check_render_sizes, worker_allows_render

logger = logging.getLogger(__name__)
_config_cache = (0, {})
_offline_until = 0
# The home link carries ~40 Mbit/s downstream. Missing input bytes up to MAX_TRANSFER go at
# once ("small lane"); larger transfers (up to the protocol's MAX_TOTAL) need one of
# BIG_SLOTS container-wide slots, so at most that many big uploads share the link and small
# jobs plus health probes keep getting through. Input admission uses the independent
# pc-transfer-limits control; without a free slot server renders natively.
MAX_TRANSFER = int(float(os.environ.get('VF_PC_BOOST_MAX_TRANSFER_MB', '24')) * 1024 * 1024)
BIG_SLOTS = max(0, int(os.environ.get('VF_PC_BOOST_BIG_SLOTS', '2')))
IMAGE_SUFFIXES = ('.jpg', '.jpeg', '.png', '.webp', '.bmp')
LOCK_DIR = Path(os.environ.get('VF_PC_BOOST_LOCK_DIR', '/data/runtime'))


class NoBigSlot(Exception):
    """All big-transfer slots are busy; render natively without an offline cooldown."""


def acquire_big_slot():
    """Non-blocking cross-process slot (flock); FFlow workers are separate processes."""
    try:
        import fcntl
    except ImportError:
        return None
    for index in range(BIG_SLOTS):
        try:
            handle = open(LOCK_DIR / f'pc-boost-big-{index}.lock', 'a+')
        except OSError:
            return None
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError:
            handle.close()
    return None


def runtime_settings():
    global _config_cache
    now = time.monotonic()
    if now - _config_cache[0] > 1:
        try:
            path = Path(os.environ.get('VF_PC_BOOST_CONFIG', '/data/runtime/pc-boost.json'))
            value = json.loads(path.read_text())
            if not isinstance(value, dict):
                value = {}
        except Exception:
            value = {}
        _config_cache = (now, value)
    return _config_cache[1]


def contained(path, roots):
    resolved = path.resolve(strict=True)
    if not any(resolved.is_relative_to(root.resolve()) for root in roots):
        raise ValueError('File outside allowed media roots')
    return resolved


def resolve_default_credit_font():
    """Resolve the server's native drawtext default, never a client-chosen font."""
    try:
        result = subprocess.run(['fc-match', '-f', '%{file}\n%{index}\n', 'sans'],
                                capture_output=True, check=True, timeout=5)
        lines = result.stdout.decode('utf-8').splitlines()
        if len(lines) != 2 or lines[1] != '0':
            raise ValueError('Unsupported default font face')
        path = Path(lines[0])
        if (not path.is_absolute() or path.is_symlink() or not path.is_file()
                or path.suffix.lower() not in ('.ttf', '.otf')):
            raise ValueError('Invalid default font')
        contained(path, [Path('/usr/share/fonts'), Path('/usr/local/share/fonts')])
        return path
    except (OSError, subprocess.SubprocessError, UnicodeError) as exc:
        raise ValueError('Default credit font unavailable') from exc


def prepare_request(command, roots):
    if not isinstance(command, list) or len(command) < 4:
        raise ValueError('Unsupported command')
    argv = list(command[1:])
    output = Path(argv[-1])
    if not output.is_absolute() or output.suffix.lower() not in ('.mp4', '.png', '.jpg', '.jpeg', '.wav', '.mp3', '.m4a', '.aac', '.flac') or output.is_symlink():
        raise ValueError('Unsupported output')
    contained(output.parent, roots)
    limits = read_transfer_limits()
    files, sources, sizes = {}, {}, []
    for pos, arg in enumerate(argv[:-1]):
        if arg != '-i':
            continue
        path = Path(argv[pos + 1])
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise ValueError('Only regular local files can offload')
        contained(path, roots)
        if path.resolve() == output.resolve():
            raise ValueError('Input/output collision')
        size = path.stat().st_size
        sizes.append(size)
        check_render_sizes(sizes, limits)
        name = '@' + str(len(files)) + path.suffix.lower()
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if path.stat().st_size != size:
            raise ValueError('Input changed during read')
        files[name] = {'sha256': digest.hexdigest(), 'size': size}
        sources[name] = path
        argv[pos + 1] = name
    for pos, arg in enumerate(argv[:-1]):
        if arg not in ('-vf', '-filter:v'):
            continue
        spec = parse_native_credit_filter(argv[pos + 1])
        if spec is None:
            continue  # validate_argv rejects every other drawtext graph.
        text_path = Path(spec['text_path'])
        expected = output.as_posix() + '.credit.txt'
        if spec['text_path'] != expected:
            raise ValueError('Credit text must belong to this exact output')
        if not text_path.is_file() or text_path.is_symlink():
            raise ValueError('Missing regular credit text')
        contained(text_path, roots)
        font = resolve_default_credit_font()
        font_name = '@credit' + font.suffix.lower()
        if font_name not in ('@credit.ttf', '@credit.otf'):
            raise ValueError('Unsupported credit font')
        for name, path in (('@credit.txt', text_path), (font_name, font)):
            if name in files:
                raise ValueError('Only one credit overlay is allowed')
            data = read_credit_asset(path, name)
            sizes.append(len(data))
            check_render_sizes(sizes, limits)
            files[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
            sources[name] = path
        argv[pos + 1] = prepare_credit_filter(spec, font_name)
    argv[-1] = 'output' + output.suffix.lower()
    validate_argv(argv, files)
    # VidForge keeps the native CPU AVC contract. Home-PC CPU encoding and
    # CUDA SigLIP remain available; NVENC transform-bypass chunks do not.
    gpu_eligible = False
    return {'argv': argv, 'files': files, 'gpuEligible': gpu_eligible}, output, sources


def select_gpu_policy(payload, output, health):
    # Only this VF hook authorizes regular NVENC; old/other clients stay unchanged.
    owned = any(prefix in output.as_posix() for prefix in ('/engines/fflow/tmp/', '/engines/fflow/media/'))
    if (owned and output.suffix.lower() == '.mp4'
            and (health.get('gpuEncodingOnly') is True or (health.get('nvencReady') is True
                 and health.get('gpuMode') == 'nvenc-high-qp14-v1'))):
        payload['gpuPolicy'] = 'nvenc-high-qp14-v1'


def http_request(url, token, method, path, data=None, timeout=5):
    request = urllib.request.Request(url.rstrip('/') + path,
        data=None if data is None else json.dumps(data).encode('utf-8'), method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        length = int(response.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_BODY:
            raise ValueError('Invalid worker response size')
        raw = response.read(MAX_BODY + 1)
        if len(raw) != length or len(raw) > MAX_BODY:
            raise ValueError('Truncated worker response')
        return json.loads(raw)



def missing_blobs(url, token, files):
    """Content-addressed: only sources the PC does not hold yet cross the tunnel."""
    return {name: reference for name, reference in files.items()
            if not http_request(url, token, 'GET', '/blobs/' + reference['sha256'], None, 5).get('present')}


def upload_missing_blobs(url, token, files, sources):
    upload_blobs(url, token, missing_blobs(url, token, files), sources)


def upload_with_lane(url, token, files, sources):
    """Small transfers go at once; big ones hold a slot for exactly the upload's duration
    (released in this thread, so an abandoned offload cannot leak extra parallel uploads)."""
    missing = missing_blobs(url, token, files)
    if sum(reference['size'] for reference in missing.values()) <= MAX_TRANSFER:
        upload_blobs(url, token, missing, sources)
        return
    slot = acquire_big_slot()
    try:
        from .pc_home_queue import HOME_SCOPE
    except ImportError:
        try:
            from pc_home_queue import HOME_SCOPE
        except ImportError:
            HOME_SCOPE = None
    # Dedicated Home work may queue behind the same two upload slots. It must
    # not fall back merely because another Home transfer is in progress.
    if slot is None and HOME_SCOPE is not None and HOME_SCOPE.get():
        deadline = time.monotonic() + 60
        while slot is None and time.monotonic() < deadline:
            time.sleep(.1)
            slot = acquire_big_slot()
    if slot is None:
        raise NoBigSlot()
    try:
        upload_blobs(url, token, missing, sources)
    finally:
        slot.close()


def upload_blobs(url, token, missing, sources):
    parsed = urlsplit(url)
    for name, reference in missing.items():
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 18191, timeout=60)
        try:
            connection.putrequest('PUT', '/blobs/' + reference['sha256'])
            connection.putheader('Authorization', 'Bearer ' + token)
            connection.putheader('Content-Type', 'application/octet-stream')
            connection.putheader('Content-Length', str(reference['size']))
            connection.endheaders()
            with sources[name].open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    connection.send(chunk)
            response = connection.getresponse()
            response.read(65536)
            if response.status != 200:
                raise urllib.error.HTTPError(url, response.status, 'blob upload rejected', None, None)
        finally:
            connection.close()


async def publish_output(result, output, ffmpeg, expected_duration):
    encoded = result.get('data')
    if not isinstance(encoded, str) or len(encoded) > MAX_OUTPUT * 4 // 3 + 4:
        raise ValueError('Invalid output size')
    data = base64.b64decode(encoded, validate=True)
    if not 32 < len(data) <= MAX_OUTPUT or hashlib.sha256(data).hexdigest() != result.get('sha256'):
        raise ValueError('Invalid output integrity')
    if output.suffix == '.mp4' and data[4:8] != b'ftyp':
        raise ValueError('Invalid MP4 header')
    descriptor, temporary = tempfile.mkstemp(prefix='.pc-boost-', suffix=output.suffix, dir=output.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
        await publish_file(temporary, output, ffmpeg, expected_duration)
    finally:
        Path(temporary).unlink(missing_ok=True)


async def publish_file(temporary, output, ffmpeg, expected_duration):
    process = None
    try:
        process = await asyncio.create_subprocess_exec(ffmpeg, '-v', 'error', '-xerror', '-nostdin',
            '-threads', '1', '-i', temporary, '-map', '0', '-progress', 'pipe:1', '-f', 'null', '-',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=45)
        if process.returncode:
            raise ValueError('Remote output failed local decode')
        times = [int(line.split('=', 1)[1]) / 1_000_000 for line in stdout.decode().splitlines()
                 if line.startswith('out_time_us=') and line.split('=', 1)[1].lstrip('-').isdigit()]
        frames = [int(line.split('=', 1)[1]) for line in stdout.decode().splitlines()
                  if line.startswith('frame=') and line.split('=', 1)[1].isdigit()]
        is_image = output.suffix in ('.png', '.jpg', '.jpeg')
        if (is_image and max(frames, default=0) != 1) or (not is_image and (not times or max(times) <= 0)):
            raise ValueError('Empty video output')
        if expected_duration and not is_image and abs(max(times) - expected_duration) > max(.5, expected_duration * .03):
            raise ValueError('Unexpected output duration')
        os.replace(temporary, output)
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.wait()
        Path(temporary).unlink(missing_ok=True)


async def download_and_publish(url, token, identifier, result, output, ffmpeg, expected_duration):
    if result.get('suffix') != output.suffix or not 32 < result.get('size', 0) <= MAX_OUTPUT:
        raise ValueError('Invalid output metadata')
    descriptor, temporary = tempfile.mkstemp(prefix='.pc-boost-', suffix=output.suffix, dir=output.parent)
    os.close(descriptor)
    stop = threading.Event()
    def download():
        request = urllib.request.Request(url.rstrip('/') + '/renders/' + identifier + '/output',
            headers={'Authorization': 'Bearer ' + token})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        digest, size = hashlib.sha256(), 0
        with opener.open(request, timeout=10) as response, open(temporary, 'wb') as stream:
            if int(response.headers.get('Content-Length', '0')) != result['size']:
                raise ValueError('Output size mismatch')
            while chunk := response.read(1024 * 1024):
                if stop.is_set():
                    return
                size += len(chunk)
                if size > result['size']:
                    raise ValueError('Output transfer limit')
                digest.update(chunk)
                stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        if size != result['size'] or digest.hexdigest() != result['sha256']:
            raise ValueError('Output transfer integrity failed')
    task = asyncio.create_task(asyncio.to_thread(download))
    try:
        await asyncio.shield(task)
        await publish_file(temporary, output, ffmpeg, expected_duration)
    finally:
        stop.set()
        await asyncio.gather(task, return_exceptions=True)
        Path(temporary).unlink(missing_ok=True)


async def try_offload(command, timeout=None, expected_duration=None, cancellation_event=None,
                      *, settings=None, roots=None, url=None, token=None, cancellation_error=asyncio.CancelledError):
    global _offline_until
    if cancellation_event is not None and cancellation_event.is_set():
        raise cancellation_error('FFmpeg process was cancelled')
    if not mod_enabled('homeFfmpeg'):
        return None
    explicit_url = url is not None
    settings = runtime_settings() if settings is None else settings
    if settings.get('enabled') is not True or (not explicit_url and time.monotonic() < _offline_until):
        return None
    url = url or os.environ.get('VF_PC_BOOST_FFMPEG_URL', 'http://10.0.3.1:18191')
    roots = roots or [Path(p) for p in os.environ.get('VF_PC_BOOST_MEDIA_ROOTS', '/data/engines/fflow/media:/data/engines/fflow/tmp').split(os.pathsep)]
    identifier, cancel_task = None, None
    try:
        try:
            payload, output, sources = await asyncio.to_thread(prepare_request, command, roots)
        except ValueError:
            return None
        # Single-frame stills (scene thumbnails) take well under a second natively, but >= 5
        # tunnel round trips on the PC (1-3 s each) while the FFlow slot stays held - measured
        # 7.2 s per thumbnail and scene jobs ~2x slower. Only offload real encodes.
        if output.suffix.lower() in IMAGE_SUFFIXES:
            return None
        total = sum(reference['size'] for reference in payload['files'].values())
        if total > MAX_TRANSFER and BIG_SLOTS == 0:
            return None
        if token is None:
            token = Path(os.environ.get('VF_PC_BOOST_TOKEN_FILE', '/data/runtime/pc-boost-token')).read_text().strip()
        health = await asyncio.to_thread(http_request, url, token, 'GET', '/health')
        if not health.get('ready') or not health.get('config', {}).get('enabled'):
            return None
        if '@credit.txt' in payload['files'] and (health.get('protocolVersion', 1) < 2
                or type(health.get('creditAssetsVersion')) is not int
                or health['creditAssetsVersion'] != CREDIT_ASSETS_VERSION):
            return None
        sizes = [reference['size'] for reference in payload['files'].values()]
        if not worker_allows_render(sizes, health.get('transferLimits')):
            return None
        # Older inline-base64 workers retain their original physical memory bounds.
        if health.get('protocolVersion', 1) < 2 and (max(sizes) > MAX_INPUT or total > MAX_TOTAL):
            return None
        select_gpu_policy(payload, output, health)
        gpu_free = (payload.get('gpuEligible') or payload.get('gpuPolicy')) and health.get('gpuBusy', 0) < health.get('gpuCapacity', 0)
        if not gpu_free and health.get('cpuBusy', 0) >= health.get('cpuCapacity', 0):
            return None

        async def execute_remote():
            nonlocal identifier
            payload['timeout'] = min(180, max(1, float(timeout or 180)))
            if health.get('protocolVersion', 1) >= 2:
                await asyncio.to_thread(upload_with_lane, url, token, payload['files'], sources)
            elif total > MAX_TRANSFER:
                raise NoBigSlot()  # protocol v1 inlines base64; never push big inputs that way
            else:
                for name, path in sources.items():
                    payload['files'][name] = base64.b64encode(path.read_bytes()).decode('ascii')
            submitted = await asyncio.to_thread(http_request, url, token, 'POST', '/renders', payload, 15)
            identifier = submitted['id']
            while True:
                metadata = health.get('protocolVersion', 1) >= 2
                result = await asyncio.to_thread(http_request, url, token, 'GET', '/renders/' + identifier + ('?metadata=1' if metadata else ''), None, 15)
                if result['state'] == 'done':
                    if metadata:
                        await download_and_publish(url, token, identifier, result, output, command[0], expected_duration)
                    else:
                        await publish_output(result, output, command[0], expected_duration)
                    logger.info('PC boost completed lane=%s', result.get('lane', 'cpu'))
                    return (0, 'PC boost ' + result.get('lane', 'cpu') + ' output verified')
                if result['state'] == 'failed':
                    logger.info('PC render failed (%s); preserving native fallback', result.get('error', 'unknown'))
                    raise RuntimeError('Worker render failed')
                await asyncio.sleep(.2)

        task = asyncio.create_task(execute_remote())
        if cancellation_event is not None:
            cancel_task = asyncio.create_task(cancellation_event.wait())
        try:
            done, _ = await asyncio.wait([task] + ([cancel_task] if cancel_task else []),
                                        timeout=min(210, max(1, float(timeout or 210))), return_when=asyncio.FIRST_COMPLETED)
            if cancel_task in done and cancel_task is not None:
                raise cancellation_error('FFmpeg process was cancelled')
            if task not in done:
                raise TimeoutError('PC render timeout')
            result=await task
            try:
                from .pc_home_queue import note_remote_success
            except ImportError:
                from pc_home_queue import note_remote_success
            note_remote_success()
            return result
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if cancel_task:
                cancel_task.cancel()
                await asyncio.gather(cancel_task, return_exceptions=True)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if isinstance(exc, cancellation_error):
            raise
        if cancellation_event is not None and cancellation_event.is_set():
            raise cancellation_error('FFmpeg process was cancelled') from None
        busy = isinstance(exc, NoBigSlot) or (isinstance(exc, urllib.error.HTTPError) and exc.code == 503)
        if not explicit_url and not busy:
            _offline_until = time.monotonic() + 5
        if busy:
            return None
        logger.info('PC boost unavailable (%s); using original native executor', type(exc).__name__)
        return None
    finally:
        if identifier:
            try:
                await asyncio.to_thread(http_request, url, token, 'DELETE', '/renders/' + identifier, None, .7)
            except Exception:
                pass
