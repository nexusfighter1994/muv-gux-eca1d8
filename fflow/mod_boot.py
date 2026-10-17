"""One immutable policy per container generation, shared by Node and Python consumers."""
import argparse
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import sqlite3
import tempfile


IDS = ('queueLimit', 'autoRetry', 'surplusRouting', 'surplusRetry', 'marketGuard',
       'thumbnailOpenlux', 'thumbnailIdentity', 'fishFree', 'ai33Stt', 'sourcingDeadline', 'chunkWatchdog',
       'sheetBatch', 'restage', 'fallbacks', 'engineRetry', 'mapAdmission', 'ffmpegAdmission',
       'mapIsolation', 'streamCompat', 'gpuEvents', 'homeQueue', 'homeFfmpeg', 'homeSiglip',
       'homeScenes', 'homeMap', 'homeMotion', 'serverBoost', 'slotCleanup', 'fxRetention', 'fxSentinel')
MAX_BYTES = 65536


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate mod policy key')
        result[key] = value
    return result


def decode(raw):
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError('Invalid mod policy size')
    value = json.loads(raw, object_pairs_hook=unique)
    if (not isinstance(value, dict) or type(value.get('version')) is not int
            or value['version'] != 1 or not isinstance(value.get('mods'), dict)
            or any(key not in IDS or type(flag) is not bool for key, flag in value['mods'].items())):
        raise ValueError('Invalid mod policy')
    return value


def generation_id():
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    fields = Path('/proc/1/stat').read_text().rpartition(')')[2].split()
    if not boot or len(fields) < 20 or not fields[19].isdigit():
        raise RuntimeError('Container generation identity unavailable')
    return boot + ':' + fields[19]


@contextmanager
def exclusive(file):
    with file.open('a+b') as stream:
        if os.name == 'nt':
            import msvcrt
            if stream.tell() == 0:
                stream.write(b'0')
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def desired(database):
    defaults = {'version': 1, 'revision': None, 'changedAt': None, 'mods': dict.fromkeys(IDS, True)}
    if not database.exists():
        return defaults
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)) as connection:
        exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").fetchone()
        if not exists:
            return defaults
        row = connection.execute("SELECT value_json FROM app_settings WHERE key='vf_mods'").fetchone()
    if not row:
        return defaults
    value = decode(row[0])
    if (set(value) != {'version', 'revision', 'changedAt', 'mods'}
            or not isinstance(value['revision'], str) or not isinstance(value['changedAt'], str)):
        raise ValueError('Invalid desired mod policy envelope')
    return {**value, 'mods': {**defaults['mods'], **value['mods']}}


def load_snapshot(*, database=None, runtime=None, generation=None):
    # Engine DATA_DIR points at its own storage, not the application's database.
    database = Path(database) if database is not None else Path(os.environ.get('VF_MODS_DATABASE') or '/data/vidforge.db')
    runtime = Path(runtime) if runtime is not None else Path('/data/runtime/vf-mods-active.json')
    generation = generation or generation_id()
    runtime.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with exclusive(runtime.with_name(runtime.name + '.lock')):
        try:
            with runtime.open('rb') as stream:
                raw = stream.read(MAX_BYTES + 1)
            # A previous generation may use an older schema. Never activate its flags.
            if not raw or len(raw) > MAX_BYTES:
                raise ValueError('Invalid active mod policy size')
            header = json.loads(raw, object_pairs_hook=unique)
            if not isinstance(header, dict):
                raise ValueError('Invalid active mod policy envelope')
        except FileNotFoundError:
            header = {}
        except (ValueError, UnicodeError):
            raise ValueError('Invalid active mod policy; refusing to process work') from None
        if isinstance(header, dict) and header.get('generation') == generation:
            return decode(raw)
        state = {**desired(database), 'generation': generation}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=runtime.parent,
                                             prefix=runtime.name + '.', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(state, stream, separators=(',', ':'))
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, runtime)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return state


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path)
    args = parser.parse_args()
    print(json.dumps(load_snapshot(runtime=args.runtime), separators=(',', ':')))
