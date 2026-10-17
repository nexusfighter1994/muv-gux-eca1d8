"""Optional FFlow scene-detection offload to the home PC.

The PC runs only the PySceneDetect pass inside WSL with the server's exact packages (verified
identical on real sources: numpy 2.5.1, opencv-python 5.0.0.93 / avcodec 62.28.101, scenedetect
0.7). Filtering, fallback intervals and windowing run here with FFlow's own scenes.py code, so
identical raw cuts give identical shots. Any failure returns None and the caller runs the native
detect_video_scenes exactly as before.
"""
import asyncio
import hashlib
import logging
import math
import os
from pathlib import Path
import time
import urllib.error

from . import pc_ffmpeg_hook as ffhook
from .pc_ffmpeg_protocol import SCENE_MAX_INPUT
from .pc_transfer_limits import scene_limit_bytes, worker_allows_scene
from .mod_flags import mod_enabled
from .scenes import DetectionMetadata, fallback_interval_scenes, window_detected_scenes

logger = logging.getLogger(__name__)
_offline_until = 0
# v13: the PC lane runs outside the FFlow/FFmpeg slots (pc_only inline request), so big sources
# are worth it: 100-180 MB upload in 6-20 s (150 Mbit/s PC cap) vs 30-300 s native detection;
# the PC decodes ~500 fps per worker. The whole PC attempt (slot wait, upload, detection) must
# end inside FFlow's 300 s scene timeout with room for thumbnails; Node then runs native.
PC_SCENE_BUDGET = float(os.environ.get('VF_PC_SCENE_BUDGET', '230'))
# Big uploads share BIG_SLOTS with render offloads; a short wait beats minutes of native work.
PC_SCENE_SLOT_WAIT = float(os.environ.get('VF_PC_SCENE_SLOT_WAIT', '45'))
SCENE_MAX_BYTES = int(min(SCENE_MAX_INPUT, float(os.environ.get('VF_PC_SCENE_MAX_MB', '400')) * 1024 * 1024))


_health_cache = (0.0, None)
_control_cache = (0.0, {})


def _control(max_age=5.0):
    """Live switch without redeploy: /data/runtime/pc-scene.json {"enabled": bool, "maxMb": number}."""
    global _control_cache
    checked, control = _control_cache
    if time.monotonic() - checked > max_age:
        try:
            import json
            control = json.loads(Path(os.environ.get('VF_PC_SCENE_CONTROL', '/data/runtime/pc-scene.json')).read_text())
            if not isinstance(control, dict):
                control = {}
        except (OSError, ValueError):
            control = {}
        _control_cache = (time.monotonic(), control)
    return control


async def _health(url, token, max_age=3.0):
    """One health round trip per few seconds instead of one per job (the link adds 1-3 s)."""
    global _health_cache
    checked, health = _health_cache
    if health is None or time.monotonic() - checked > max_age:
        health = await asyncio.to_thread(ffhook.http_request, url, token, 'GET', '/health')
        _health_cache = (time.monotonic(), health)
    return health


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _upload(url, token, files, sources, slot_deadline):
    """upload_with_lane, but big transfers wait (bounded) for a slot instead of giving up."""
    missing = ffhook.missing_blobs(url, token, files)
    if sum(reference['size'] for reference in missing.values()) <= ffhook.MAX_TRANSFER:
        ffhook.upload_blobs(url, token, missing, sources)
        return
    while True:
        slot = ffhook.acquire_big_slot()
        if slot is not None:
            break
        if time.monotonic() >= slot_deadline:
            raise ffhook.NoBigSlot()
        time.sleep(0.5)
    try:
        ffhook.upload_blobs(url, token, missing, sources)
    finally:
        slot.close()


def _number_or_none(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Invalid number')
    return float(value)


def _validated(result):
    scenes = result.get('scenes')
    if not isinstance(scenes, list):
        raise ValueError('Invalid scenes')
    cleaned = []
    for scene in scenes:
        if not isinstance(scene, list) or len(scene) != 2:
            raise ValueError('Invalid scene')
        start, end = _number_or_none(scene[0]), _number_or_none(scene[1])
        if start is None or end is None or not end > start:
            raise ValueError('Invalid scene bounds')
        cleaned.append((start, end))
    return {'scenes': cleaned, 'duration_sec': _number_or_none(result.get('duration_sec')),
            'fps': _number_or_none(result.get('fps'))}


def finish_raw_scenes(raw, min_duration_sec, max_duration_sec, fallback_interval_sec):
    """scenes.py detect_video_scenes lines 155-181, applied to the PC's raw PySceneDetect output."""
    scenes = list(raw['scenes'])
    total_shots_detected = len(scenes)
    video_duration_sec = raw['duration_sec']
    from_fallback_interval = False
    fallback_cuts_added = 0
    if not scenes and fallback_interval_sec is not None and video_duration_sec is not None:
        scenes = fallback_interval_scenes(video_duration_sec, fallback_interval_sec)
        from_fallback_interval = True
        fallback_cuts_added = max(len(scenes) - 1, 0)
    metadata = DetectionMetadata(
        duration_sec=video_duration_sec,
        fps=raw['fps'],
        total_shots_detected=total_shots_detected,
        fallback_cuts_added=fallback_cuts_added,
    )
    return metadata, window_detected_scenes(
        scenes, min_duration_sec, max_duration_sec, from_fallback_interval=from_fallback_interval,
    )


async def try_scene_offload(video_path, threshold, *, url=None, token=None, settings=None):
    if not mod_enabled('homeScenes'):
        return None
    global _offline_until
    started = time.monotonic()
    budget_end = started + PC_SCENE_BUDGET
    settings = ffhook.runtime_settings() if settings is None else settings
    explicit_url = url is not None
    if settings.get('enabled') is not True or (not explicit_url and time.monotonic() < _offline_until):
        return None
    control = _control()
    if control.get('enabled') is False:
        return None
    url = url or os.environ.get('VF_PC_BOOST_FFMPEG_URL', 'http://10.0.3.1:18191')
    path = Path(video_path)
    identifier = None
    try:
        max_bytes = scene_limit_bytes(SCENE_MAX_BYTES, control.get('maxMb'))
        size = path.stat().st_size
        if not 0 < size <= max_bytes:
            return None
        if token is None:
            token = Path(os.environ.get('VF_PC_BOOST_TOKEN_FILE', '/data/runtime/pc-boost-token')).read_text().strip()
        health = await _health(url, token)
        if not health.get('sceneReady') or health.get('sceneBusy', 0) >= health.get('sceneCapacity', 0):
            return None
        if not worker_allows_scene(size, health.get('transferLimits')):
            return None
        source = {'sha256': await asyncio.to_thread(_sha256, path), 'size': size}
        await asyncio.to_thread(_upload, url, token, {'source.mp4': source}, {'source.mp4': path},
                                min(started + PC_SCENE_SLOT_WAIT, budget_end - 60))
        # Detection gets what is left of the budget (the PC kills it at that point).
        detect_timeout = min(600.0, budget_end - time.monotonic() - 15)
        if detect_timeout < 20:
            logger.info('PC scene detection skipped: upload used the budget; using native detection')
            return None
        submitted = await asyncio.to_thread(ffhook.http_request, url, token, 'POST', '/scenes',
            {'source': source, 'threshold': float(threshold), 'timeout': int(detect_timeout)}, 15)
        identifier = submitted['id']
        deadline = time.monotonic() + int(detect_timeout) + 12
        while time.monotonic() < deadline:
            # Long-poll: the PC answers as soon as the job ends (max 10 s per request).
            status = await asyncio.to_thread(ffhook.http_request, url, token, 'GET',
                                             '/scenes/' + identifier + '?wait=10', None, 20)
            if status['state'] == 'done':
                result = _validated(status['result'])
                identifier = None  # finished jobs are reaped by the PC; skip a round trip
                logger.info('PC scene detection completed')
                return result
            if status['state'] == 'failed':
                identifier = None
                logger.info('PC scene detection failed (%s); using native detection', status.get('error'))
                return None
        logger.info('PC scene detection timeout; using native detection')
        return None
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        busy = isinstance(exc, ffhook.NoBigSlot) or (isinstance(exc, urllib.error.HTTPError) and exc.code == 503)
        if not explicit_url and not busy:
            _offline_until = time.monotonic() + 5
        if not busy:
            logger.info('PC scene detection unavailable (%s); using native detection', type(exc).__name__)
        return None
    finally:
        if identifier:
            try:
                await asyncio.to_thread(ffhook.http_request, url, token, 'DELETE', '/scenes/' + identifier, None, 2)
            except Exception:
                pass
