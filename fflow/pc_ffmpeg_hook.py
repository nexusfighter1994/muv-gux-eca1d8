"""Optional FFlow executor hook. Any remote failure returns None for native fallback."""
import asyncio
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import random
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
_declines = {}


def note_decline(reason, now=None):
    """Why a Home-scoped FFmpeg call ran natively: one WARNING per reason and minute (with the count).

    These calls then wait for one of the server's 6 Home recovery permits; on 2026-11-05 every
    b_roll_video trim of one job went that way and nothing recorded why."""
    now = time.monotonic() if now is None else now
    entry = _declines.setdefault(reason, {'count': 0, 'logged': -1e9, 'since': 0})
    entry['count'] += 1
    entry['since'] += 1
    if now - entry['logged'] >= 60:
        logger.warning('PC boost declined (%s): %d in the last minute, %d total', reason, entry['since'], entry['count'])
        entry['logged'], entry['since'] = now, 0
    return None


PREPARE_EFFICIENCY_VERSION = 1
_image_fastpath_logged = False
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


# 2026-11-06: small Home requests use a dedicated SSH connection (Home control-tunnel.ps1,
# 10.0.3.1:18291 -> Home 127.0.0.1:18191). On the shared tunnel they queued behind bulk transfers
# (0.9-2.3 s per request vs 50-70 ms; ~10 per trim). Blob PUTs and output downloads keep the main
# tunnel. A refused connect (forward absent) falls back at once; other control failures pause the
# control route for CONTROL_PAUSE_S. Only idempotent requests are repeated on the main tunnel.
MAIN_PORT, CONTROL_PORT, CONTROL_PAUSE_S = 18191, 18291, 60
_control = {'paused_until': 0.0, 'fallbacks': 0}


def control_url(url, now=None):
    parsed = urlsplit(url)
    now = time.monotonic() if now is None else now
    if parsed.port != MAIN_PORT or now < _control['paused_until']:
        return None
    return url.replace(':%d' % MAIN_PORT, ':%d' % CONTROL_PORT, 1)


def refused(exc):
    reason = getattr(exc, 'reason', exc)
    return isinstance(reason, ConnectionRefusedError)


# vf-custom:home-hook-timeouts-v1 (2026-11-12): control timeouts 5 -> 15 s, health 30/15 s, deadlines 900/420 s,
# Home job cap 360 s, download read 90 s. Owner: generous timeouts; 5 s control calls fell back
# natively (ctl_to 45-55 %) while the API was saturated after restarts.
def http_request(url, token, method, path, data=None, timeout=15):
    control = control_url(url)
    if control is not None:
        try:
            return direct_request(control, token, method, path, data, timeout)
        except urllib.error.HTTPError:
            raise  # Home answered: same result on either tunnel
        except (OSError, http.client.HTTPException) as exc:
            _control['paused_until'] = time.monotonic() + CONTROL_PAUSE_S
            _control['fallbacks'] += 1
            if not refused(exc) and method not in ('GET', 'DELETE'):
                raise  # the request may have reached Home; never submit twice
    return direct_request(url, token, method, path, data, timeout)


# 2026-11-06: bulk transfers (blob PUT, render output GET) spread over extra SSH connections
# (Home bulk-tunnels.ps1 -> Home 127.0.0.1:18191). One Win32-OpenSSH connection caps throughput:
# 16 MB took 10.9 s on the busy main tunnel vs 1.96 s on a quiet one; ~20 output streams ran at
# 83 KB/s each, so 20 MB composition results passed the 420 s deadline. Round-robin over the live
# bulk ports, then the main tunnel. Only a refused connect (nothing sent) moves on at once; a failed
# transfer pauses its port and raises to the existing retry paths. Home pacing still caps the line.
BULK_PORTS = (18391, 18491, 18591)
_bulk = {'next': 0, 'paused': {}}


def bulk_urls(url, now=None):
    if urlsplit(url).port != MAIN_PORT:
        return [url]
    now = time.monotonic() if now is None else now
    live = [port for port in BULK_PORTS if _bulk['paused'].get(port, 0) <= now]
    if live:
        start = _bulk['next'] % len(live)
        _bulk['next'] += 1
        live = live[start:] + live[:start]
    return [url.replace(':%d' % MAIN_PORT, ':%d' % port, 1) for port in live] + [url]


def pause_bulk(url, now=None):
    port = urlsplit(url).port
    if port in BULK_PORTS:
        _bulk['paused'][port] = (time.monotonic() if now is None else now) + CONTROL_PAUSE_S


def over_bulk(url, transfer):
    """Run transfer(target_url) on the first bulk route that accepts the connection."""
    targets = bulk_urls(url)
    for target in targets:
        try:
            return transfer(target)
        except urllib.error.HTTPError:
            raise  # Home answered
        except (OSError, http.client.HTTPException) as exc:
            pause_bulk(target)
            if not refused(exc) or target == targets[-1]:
                raise


def direct_request(url, token, method, path, data=None, timeout=15):
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
            if not http_request(url, token, 'GET', '/blobs/' + reference['sha256'], None, 15).get('present')}


def upload_missing_blobs(url, token, files, sources):
    upload_blobs(url, token, missing_blobs(url, token, files), sources)


def home_scoped():
    try:
        from .pc_home_queue import HOME_SCOPE
    except ImportError:
        try:
            from pc_home_queue import HOME_SCOPE
        except ImportError:
            return False
    return bool(HOME_SCOPE.get())


HOME_BUSY_WAIT_S = 60


async def submit_render(url, token, payload, *, wait_s=None):
    """Home-scoped work waits for a free Home slot (503 busy) instead of running natively.

    Owner 2026-11-05: no fallbacks. Several consumers saw free slots in the same health snapshot and
    the losers of that race fell back to the server's 6 recovery permits ('home 503 busy')."""
    wait_s = HOME_BUSY_WAIT_S if wait_s is None else wait_s
    deadline = time.monotonic() + (wait_s if home_scoped() else 0)
    delay = .25
    while True:
        try:
            return await asyncio.to_thread(http_request, url, token, 'POST', '/renders', payload, 15)
        except urllib.error.HTTPError as exc:
            if exc.code != 503 or time.monotonic() + delay > deadline:
                raise
        await asyncio.sleep(delay)
        delay = min(2.0, delay * 1.5)


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
        # Another render may have uploaded these inputs while this owner waited.
        missing = missing_blobs(url, token, files)
        if missing:
            upload_blobs(url, token, missing, sources)
    finally:
        slot.close()


BLOB_RETRIES = 2  # Home-scoped only


def upload_blobs(url, token, missing, sources, sleep=time.sleep):
    # 2026-11-06: 'blob upload rejected' (Home 500) and BrokenPipe on the PUT sent ~4 Home jobs
    # per 30 min to the server. Home-scoped work re-checks and re-sends the blob instead; a 4xx
    # (size cap, digest) is final. The blob is content-addressed, so a re-send is idempotent.
    attempts = 1 + (BLOB_RETRIES if home_scoped() else 0)
    for name, reference in missing.items():
        for attempt in range(attempts):
            try:
                put_blob(url, token, reference, sources[name])
                break
            except TRANSIENT_ERRORS as exc:
                if isinstance(exc, urllib.error.HTTPError) and exc.code < 500 or attempt + 1 >= attempts:
                    raise
                logger.warning('PC boost retried blob upload (%s: %s)', type(exc).__name__, exc)
                sleep(1 + attempt)
                try:
                    if not missing_blobs(url, token, {name: reference}):
                        break
                except TRANSIENT_ERRORS:
                    pass


def put_blob(url, token, reference, source):
    return over_bulk(url, lambda target: put_blob_once(target, token, reference, source))


def put_blob_once(url, token, reference, source):
    parsed = urlsplit(url)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 18191, timeout=60)
    try:
        connection.putrequest('PUT', '/blobs/' + reference['sha256'])
        connection.putheader('Authorization', 'Bearer ' + token)
        connection.putheader('Content-Type', 'application/octet-stream')
        connection.putheader('Content-Length', str(reference['size']))
        connection.endheaders()
        with source.open('rb') as stream:
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


# vf-custom:home-verify-probe-v1 (2026-11-13): the Home worker decodes every output completely before it
# returns it (pc_ffmpeg_worker.render), and the transfer is checked by size and sha256 before this point.
# Decoding the same file again here cost the server 0.85 of 16 cores (69 decodes in 40 s). With
# /data/runtime/vf-home-verify.json {"mode":"probe"} the file is read with ffprobe instead (stream present,
# duration as expected); a full decode still runs for one result in "sample" (default 20) and for every
# result of at least "alwaysMb" MiB (default 8). Missing or invalid file = full decode as before.
VERIFY_FILE = '/data/runtime/vf-home-verify.json'
_verify_cache = [0.0, None]


def verify_settings(file=None, max_age=1.0):
    now = time.monotonic()
    if file is None and _verify_cache[1] is not None and now - _verify_cache[0] < max_age:
        return _verify_cache[1]
    value = {'mode': 'decode', 'sample': 20, 'alwaysMb': 8}
    try:
        raw = json.loads(Path(file or os.environ.get('VF_HOME_VERIFY', VERIFY_FILE)).read_text(encoding='utf-8'))
        if isinstance(raw, dict) and raw.get('mode') == 'probe':
            sample, always = raw.get('sample', 20), raw.get('alwaysMb', 8)
            value = {'mode': 'probe',
                     'sample': sample if type(sample) is int and 1 <= sample <= 1000 else 20,
                     'alwaysMb': always if type(always) is int and 1 <= always <= 4096 else 8}
    except (OSError, ValueError):
        pass
    if file is None:
        _verify_cache[0], _verify_cache[1] = now, value
    return value


def full_decode_due(size, settings):
    if settings['mode'] != 'probe' or size >= settings['alwaysMb'] * 1024 * 1024:
        return True
    return random.randrange(settings['sample']) == 0


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


async def probe_output(temporary, output, ffmpeg, expected_duration):
    name = Path(ffmpeg).name
    ffprobe = str(Path(ffmpeg).with_name(name.replace('ffmpeg', 'ffprobe', 1))) if 'ffmpeg' in name else 'ffprobe'
    process = await asyncio.create_subprocess_exec(ffprobe, '-v', 'error', '-show_entries',
        'format=duration:stream=codec_type,width,height,duration', '-of', 'json', str(temporary),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=20)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode:
        raise ValueError('Remote output failed local probe')
    try:
        info = json.loads(stdout.decode() or '{}')
    except ValueError:
        raise ValueError('Remote output failed local probe') from None
    streams = [stream for stream in (info.get('streams') or []) if isinstance(stream, dict)]
    if output.suffix in ('.png', '.jpg', '.jpeg'):
        if not any(_number(stream.get('width')) > 0 and _number(stream.get('height')) > 0 for stream in streams):
            raise ValueError('Empty video output')
        return
    duration = max([_number((info.get('format') or {}).get('duration'))] + [_number(stream.get('duration')) for stream in streams])
    if not streams or duration <= 0:
        raise ValueError('Empty video output')
    if expected_duration and abs(duration - expected_duration) > max(.5, expected_duration * .03):
        raise ValueError('Unexpected output duration')


async def publish_file(temporary, output, ffmpeg, expected_duration):
    try:
        size = os.path.getsize(temporary)
    except OSError:
        size = 0
    settings = verify_settings()
    if not full_decode_due(size, settings):
        try:
            await probe_output(temporary, output, ffmpeg, expected_duration)
        except FileNotFoundError:
            pass  # no ffprobe next to ffmpeg: verify by decoding as before
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
        else:
            os.replace(temporary, output)
            return
    try:
        await decode_output(temporary, output, ffmpeg, expected_duration)
    except ValueError:
        if settings['mode'] == 'probe':
            logger.warning('home verify: full decode rejected a Home result (%d bytes, %s)', size, output.suffix)
        raise


async def decode_output(temporary, output, ffmpeg, expected_duration):
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


# Home-scoped work retries transient transfer trouble on Home instead of running natively (owner
# 2026-11-05: no fallbacks). 30 min at 22:10-22:40 had 86 timeouts, 57 failed result downloads and 16
# dropped connections, each sending a finished Home render back to the server's 6 recovery permits.
TRANSIENT_ERRORS = (TimeoutError, ConnectionError, http.client.HTTPException, urllib.error.URLError)
RETRYABLE_DOWNLOAD = ('Output transfer integrity failed', 'Output size mismatch')
POLL_RETRIES = 4
DOWNLOAD_ATTEMPTS = 3
KEEPALIVE_S = 6


def keep_alive(url, token, identifier, stop, interval=KEEPALIVE_S):
    """Home reaps a finished job 20 s after its last touch. A result stream that dies silently in the
    tunnel only shows here after the 30 s read timeout, so the retry found the job gone (404: 3 of
    764 Home jobs, 2026-11-07 03:14-03:44Z). Status reads over the control tunnel touch the job."""
    while not stop.wait(interval):
        try:
            http_request(url, token, 'GET', '/renders/' + identifier + '?metadata=1', None, 10)
        except Exception:
            pass


async def home_health(url, token):
    """Home /health answered in up to 3.5 s under load; the 5 s default plus tunnel latency timed out
    (24 of 37 Home-scoped declines 22:21-22:39 UTC). Home-scoped work waits up to 15 s, twice."""
    attempts = 2 if home_scoped() else 1
    for attempt in range(attempts):
        try:
            return await asyncio.to_thread(http_request, url, token, 'GET', '/health', None, 30 if attempts > 1 else 15)
        except TRANSIENT_ERRORS:
            if attempt + 1 >= attempts:
                raise
            await asyncio.sleep(1)


HOME_RENDER_DEADLINE_S = 900


def render_deadline(timeout):
    """Whole offload (upload, Home queue, encode, download). Home-scoped work gets 420 s: under load
    Home compositions passed 210 s and were then redone on the server (24 'PC render timeout' in
    28 min, 2026-11-06 00:10). FFlow's own shorter timeout still wins; Home stalls trip the breaker."""
    cap = HOME_RENDER_DEADLINE_S if home_scoped() else 420
    return min(cap, max(1, float(timeout or cap)))


def gone(exc):
    return isinstance(exc, urllib.error.HTTPError) and exc.code == 404


def poll_delay(polls):
    """0.2 s first, then up to 1 s: 40 renders polled every 0.2 s were ~200 requests/s through the tunnel."""
    return min(1.0, .2 * 1.5 ** polls)


async def download_with_retry(url, token, identifier, result, output, ffmpeg, expected_duration, attempts=None):
    attempts = DOWNLOAD_ATTEMPTS if attempts is None else attempts
    for attempt in range(attempts):
        try:
            return await download_and_publish(url, token, identifier, result, output, ffmpeg, expected_duration)
        except (ValueError, *TRANSIENT_ERRORS) as exc:
            # 404: the Home job is gone (its reaper removed it), a retry cannot succeed.
            retryable = (not isinstance(exc, ValueError) or str(exc) in RETRYABLE_DOWNLOAD) and not gone(exc)
            if attempt + 1 >= attempts or not retryable or not home_scoped():
                raise
            note_decline('retried download: ' + (str(exc)[:50] or type(exc).__name__))
            await asyncio.sleep(1 + attempt)


async def download_and_publish(url, token, identifier, result, output, ffmpeg, expected_duration):
    if result.get('suffix') != output.suffix or not 32 < result.get('size', 0) <= MAX_OUTPUT:
        raise ValueError('Invalid output metadata')
    descriptor, temporary = tempfile.mkstemp(prefix='.pc-boost-', suffix=output.suffix, dir=output.parent)
    os.close(descriptor)
    stop = threading.Event()
    def download():
        return over_bulk(url, download_from)
    def download_from(base):
        request = urllib.request.Request(base.rstrip('/') + '/renders/' + identifier + '/output',
            headers={'Authorization': 'Bearer ' + token})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        digest, size = hashlib.sha256(), 0
        # 30 s per read: the throttled home upload (80 Mbit, shared by all results) stalled reads > 10 s.
        with opener.open(request, timeout=90) as response, open(temporary, 'wb') as stream:
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
    threading.Thread(target=keep_alive, args=(url, token, identifier, stop, KEEPALIVE_S), daemon=True).start()
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
    global _offline_until, _image_fastpath_logged
    if cancellation_event is not None and cancellation_event.is_set():
        raise cancellation_error('FFmpeg process was cancelled')
    if not mod_enabled('homeFfmpeg'):
        return None
    explicit_url = url is not None
    settings = runtime_settings() if settings is None else settings
    if settings.get('enabled') is not True:
        return None
    if not explicit_url and time.monotonic() < _offline_until:
        return note_decline('offline cooldown after an error')
    # These always use the native executor; do not hash full videos just to decline.
    if (isinstance(command, list) and command and isinstance(command[-1], str)
            and Path(command[-1]).suffix.lower() in IMAGE_SUFFIXES):
        if not _image_fastpath_logged:
            logger.info('PC boost preparation v1: native image source hashing skipped')
            _image_fastpath_logged = True
        return None
    url = url or os.environ.get('VF_PC_BOOST_FFMPEG_URL', 'http://10.0.3.1:18191')
    roots = roots or [Path(p) for p in os.environ.get('VF_PC_BOOST_MEDIA_ROOTS', '/data/engines/fflow/media:/data/engines/fflow/tmp').split(os.pathsep)]
    identifier, cancel_task = None, None
    try:
        try:
            payload, output, sources = await asyncio.to_thread(prepare_request, command, roots)
        except ValueError as exc:
            return note_decline('prepare: ' + str(exc)[:80])
        # Single-frame stills (scene thumbnails) take well under a second natively, but >= 5
        # tunnel round trips on the PC (1-3 s each) while the FFlow slot stays held - measured
        # 7.2 s per thumbnail and scene jobs ~2x slower. Only offload real encodes.
        if output.suffix.lower() in IMAGE_SUFFIXES:
            return None
        total = sum(reference['size'] for reference in payload['files'].values())
        if total > MAX_TRANSFER and BIG_SLOTS == 0:
            return note_decline('big transfer disabled')
        if token is None:
            token = Path(os.environ.get('VF_PC_BOOST_TOKEN_FILE', '/data/runtime/pc-boost-token')).read_text().strip()
        health = await home_health(url, token)
        if not health.get('ready') or not health.get('config', {}).get('enabled'):
            return note_decline('home not ready or disabled')
        if '@credit.txt' in payload['files'] and (health.get('protocolVersion', 1) < 2
                or type(health.get('creditAssetsVersion')) is not int
                or health['creditAssetsVersion'] != CREDIT_ASSETS_VERSION):
            return None
        sizes = [reference['size'] for reference in payload['files'].values()]
        if not worker_allows_render(sizes, health.get('transferLimits')):
            return note_decline('home transfer limits')
        # Older inline-base64 workers retain their original physical memory bounds.
        if health.get('protocolVersion', 1) < 2 and (max(sizes) > MAX_INPUT or total > MAX_TOTAL):
            return None
        select_gpu_policy(payload, output, health)
        gpu_free = (payload.get('gpuEligible') or payload.get('gpuPolicy')) and health.get('gpuBusy', 0) < health.get('gpuCapacity', 0)
        if not gpu_free and health.get('cpuBusy', 0) >= health.get('cpuCapacity', 0) and not home_scoped():
            return note_decline('home cpu/gpu slots full')

        async def execute_remote():
            nonlocal identifier
            payload['timeout'] = min(360, max(1, float(timeout or 360)))
            if health.get('protocolVersion', 1) >= 2:
                await asyncio.to_thread(upload_with_lane, url, token, payload['files'], sources)
            elif total > MAX_TRANSFER:
                raise NoBigSlot()  # protocol v1 inlines base64; never push big inputs that way
            else:
                for name, path in sources.items():
                    payload['files'][name] = base64.b64encode(path.read_bytes()).decode('ascii')
            submitted = await submit_render(url, token, payload)
            identifier = submitted['id']
            polls = failures = 0
            while True:
                metadata = health.get('protocolVersion', 1) >= 2
                try:
                    result = await asyncio.to_thread(http_request, url, token, 'GET', '/renders/' + identifier + ('?metadata=1' if metadata else ''), None, 15)
                    failures = 0
                except TRANSIENT_ERRORS as exc:
                    failures += 1
                    if not home_scoped() or failures > POLL_RETRIES or gone(exc):
                        raise
                    await asyncio.sleep(min(5.0, .5 * failures))
                    continue
                if result['state'] == 'done':
                    if metadata:
                        await download_with_retry(url, token, identifier, result, output, command[0], expected_duration)
                    else:
                        await publish_output(result, output, command[0], expected_duration)
                    logger.info('PC boost completed lane=%s', result.get('lane', 'cpu'))
                    return (0, 'PC boost ' + result.get('lane', 'cpu') + ' output verified')
                if result['state'] == 'failed':
                    logger.info('PC render failed (%s); preserving native fallback', result.get('error', 'unknown'))
                    raise RuntimeError('Worker render failed')
                await asyncio.sleep(poll_delay(polls))
                polls += 1

        task = asyncio.create_task(execute_remote())
        if cancellation_event is not None:
            cancel_task = asyncio.create_task(cancellation_event.wait())
        try:
            done, _ = await asyncio.wait([task] + ([cancel_task] if cancel_task else []),
                                        timeout=render_deadline(timeout), return_when=asyncio.FIRST_COMPLETED)
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
            return note_decline(('no big-transfer slot' if isinstance(exc, NoBigSlot) else 'home 503 busy')
                                + (' [home]' if home_scoped() else ''))
        logger.info('PC boost unavailable (%s); using original native executor', type(exc).__name__)
        return note_decline('error ' + type(exc).__name__ + ': ' + str(exc)[:70] + (' [home]' if home_scoped() else '') + ' (5 s offline)')
    finally:
        if identifier:
            try:
                await asyncio.to_thread(http_request, url, token, 'DELETE', '/renders/' + identifier, None, .7)
            except Exception:
                pass
