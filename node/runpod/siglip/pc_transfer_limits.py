"""Shared MiB admission limits; a bad control file disables offload, not native work."""
import json
import os
from pathlib import Path
import re
import threading
import time

MIB = 1024 * 1024
DEFAULT_LIMITS = dict(ffmpegMaxFileMb=64, ffmpegMaxTotalMb=96,
                      sceneMaxFileMb=400, siglipMaxImageMb=20)
MAXIMA = dict(ffmpegMaxFileMb=4096, ffmpegMaxTotalMb=4096,
              sceneMaxFileMb=4096, siglipMaxImageMb=128)
_cache = None
_lock = threading.Lock()
_revision = re.compile(r'^[0-9a-f-]{36}$')


def validate_limits(update, current=None):
    if not isinstance(update, dict) or set(update) - set(DEFAULT_LIMITS):
        raise ValueError('Unknown transfer-limit keys')
    result = dict(DEFAULT_LIMITS if current is None else current)
    result.update(update)
    if set(result) != set(DEFAULT_LIMITS):
        raise ValueError('Incomplete transfer limits')
    for key, maximum in MAXIMA.items():
        if type(result[key]) is not int or not 1 <= result[key] <= maximum:
            raise ValueError('Transfer limit outside safe MiB range')
    return result


def read_state(file=None, max_age=1.0):
    global _cache
    file = Path(file or os.environ.get('VF_PC_TRANSFER_LIMITS', '/data/runtime/pc-transfer-limits.json'))
    identity, now = str(file), time.monotonic()
    with _lock:
        if max_age > 0 and _cache and _cache[0] == identity and now - _cache[1] < max_age:
            return {**_cache[2], 'limits': dict(_cache[2]['limits'])}
        try:
            if file.is_symlink():
                raise ValueError('Transfer limits must be a regular file')
            with file.open('rb') as stream:
                raw = stream.read(8193)
            if not raw or len(raw) > 8192:
                raise ValueError('Invalid transfer-limit file size')
            state = json.loads(raw)
            if not isinstance(state, dict) or set(state) not in (set(DEFAULT_LIMITS), set(DEFAULT_LIMITS) | {'revision'}):
                raise ValueError('Invalid transfer-limit file schema')
            revision = state.get('revision')
            if revision is not None and (not isinstance(revision, str) or not _revision.fullmatch(revision)):
                raise ValueError('Invalid transfer-limit revision')
            limits = validate_limits({key: state[key] for key in DEFAULT_LIMITS})
            result = dict(limits=limits, revision=revision, configured=True)
        except FileNotFoundError:
            result = dict(limits=dict(DEFAULT_LIMITS), revision=None, configured=False)
        except (OSError, ValueError, TypeError) as exc:
            _cache = None
            raise ValueError('Transfer-limit state unavailable') from exc
        _cache = (identity, now, result)
        return {**result, 'limits': dict(result['limits'])}


def read_limits(file=None, max_age=1.0):
    return read_state(file, max_age)['limits']


def check_render_sizes(sizes, limits):
    limits = validate_limits(limits)
    if not sizes or len(sizes) > 8 or any(type(size) is not int or size <= 0 for size in sizes):
        raise ValueError('Invalid render input sizes')
    if any(size > limits['ffmpegMaxFileMb'] * MIB for size in sizes):
        raise ValueError('Render input exceeds per-file offload limit')
    if sum(sizes) > limits['ffmpegMaxTotalMb'] * MIB:
        raise ValueError('Render inputs exceed total offload limit')


def confirmed_worker_limits(value):
    if value is None:
        return dict(DEFAULT_LIMITS)
    if not isinstance(value, dict) or set(value) != set(DEFAULT_LIMITS):
        raise ValueError('Invalid worker transfer-limit readback')
    return validate_limits(value)


def worker_allows_render(sizes, value):
    try:
        check_render_sizes(sizes, confirmed_worker_limits(value))
        return True
    except ValueError:
        return False


def scene_limit_bytes(default_bytes, legacy_mb=None, *, file=None, max_age=1.0):
    state = read_state(file, max_age)
    if state['configured']:
        return state['limits']['sceneMaxFileMb'] * MIB
    # Preserve the pre-existing scene-only override until the new controls are saved.
    if type(legacy_mb) in (int, float) and 0 <= legacy_mb <= 400:
        return int(legacy_mb * MIB)
    return min(400 * MIB, default_bytes)


def worker_allows_scene(size, value):
    try:
        return type(size) is int and 0 < size <= confirmed_worker_limits(value)['sceneMaxFileMb'] * MIB
    except ValueError:
        return False


def check_image_size(size, limits):
    limits = validate_limits(limits)
    if type(size) is not int or not 0 < size <= limits['siglipMaxImageMb'] * MIB:
        raise ValueError('Image exceeds per-file offload limit')

