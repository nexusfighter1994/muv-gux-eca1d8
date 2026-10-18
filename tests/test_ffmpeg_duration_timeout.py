import asyncio
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('ffmpeg_duration_timeout', Path(__file__).resolve().parents[1] / 'fflow' / 'ffmpeg_duration_timeout.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_timeout_grows_to_the_media_length_and_never_shrinks():
    assert mod.scaled_timeout(600.0, 4824.1) == 4824.1  # 80 min voiceover normalize
    assert mod.scaled_timeout(600.0, 30.0) == 600.0
    assert mod.scaled_timeout(600.0, None) == 600.0
    assert mod.scaled_timeout(600.0, 'bad') == 600.0
    assert mod.scaled_timeout(None, 4824.1) is None  # "no timeout" stays unlimited


def test_install_wraps_execute_for_keyword_and_positional_calls():
    seen = []

    class Executor:
        async def execute(self, command, timeout=None, expected_duration=None, progress_callback=None, cancellation_event=None, slot_kind='ffmpeg'):
            seen.append((command, timeout, expected_duration, progress_callback, slot_kind))
            return 0, ''

    mod.install_duration_timeout(Executor)
    mod.install_duration_timeout(Executor)  # idempotent
    run = asyncio.run
    run(Executor().execute(['ffmpeg'], timeout=600.0, expected_duration=4824.1))
    run(Executor().execute(['ffmpeg'], 600.0, 10.0, 'cb', slot_kind='probe'))
    run(Executor().execute(['ffmpeg']))
    assert seen == [(['ffmpeg'], 4824.1, 4824.1, None, 'ffmpeg'), (['ffmpeg'], 600.0, 10.0, 'cb', 'probe'), (['ffmpeg'], None, None, None, 'ffmpeg')]
