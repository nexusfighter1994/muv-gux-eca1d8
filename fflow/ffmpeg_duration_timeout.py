"""Long media must not hit FFlow's fixed FFmpeg timeouts.

FFlow passes fixed timeouts (audio normalize: 600 s) regardless of the media length; an 80 min
voiceover (4824 s) normalize timed out at 67-93 % under load and failed the job. With a known
expected duration the timeout is at least that duration (1x realtime); it is never lowered.
"""
import functools


def scaled_timeout(timeout, expected_duration):
    try:
        duration = float(expected_duration or 0)
    except (TypeError, ValueError):
        return timeout
    if timeout is None or not duration > 0:
        return timeout
    return max(float(timeout), duration)


def install_duration_timeout(cls):
    if getattr(cls, '_vf_duration_timeout', False):
        return
    original = cls.execute

    @functools.wraps(original)
    async def execute(self, command, timeout=None, expected_duration=None, *args, **kwargs):
        return await original(self, command, scaled_timeout(timeout, expected_duration), expected_duration, *args, **kwargs)

    cls.execute = execute
    cls._vf_duration_timeout = True
