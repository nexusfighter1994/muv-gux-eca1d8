"""Read the app's active boot snapshot once; desired settings are never read here."""
import json
import os
from pathlib import Path
from types import MappingProxyType


_SNAPSHOT = Path('/data/runtime/vf-mods-active.json')
_MAX_BYTES = 65536
_OFFLOAD = frozenset(('homeFfmpeg', 'homeScenes', 'homeQueue', 'homeSiglip'))


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate snapshot key')
        result[key] = value
    return result


def _reject_constant(_value):
    raise ValueError('Invalid snapshot constant')


def _read_snapshot():
    if os.environ.get('VF_MODS_BOOTSTRAP') == '1':
        try:
            from .mod_boot import load_snapshot
        except ImportError:
            from mod_boot import load_snapshot
        # Startup errors propagate: no consumer may silently process with stale flags.
        return MappingProxyType(dict(load_snapshot()['mods']))
    try:
        with _SNAPSHOT.open('rb') as stream:
            raw = stream.read(_MAX_BYTES + 1)
        if not raw or len(raw) > _MAX_BYTES:
            raise ValueError('Invalid snapshot size')
        value = json.loads(raw, object_pairs_hook=_unique_object,
                           parse_constant=_reject_constant)
        if (not isinstance(value, dict) or type(value.get('version')) is not int
                or value['version'] != 1 or not isinstance(value.get('mods'), dict)
                or any(type(flag) is not bool for flag in value['mods'].values())):
            raise ValueError('Invalid snapshot schema')
        return MappingProxyType(dict(value['mods']))
    except FileNotFoundError:
        return MappingProxyType({})
    except (OSError, ValueError, UnicodeError, RecursionError):
        # Corrupt state may remove acceleration, never reservation or media safeguards.
        return MappingProxyType({key: False for key in _OFFLOAD})


_MODS = _read_snapshot()


def mod_enabled(key):
    return _MODS.get(key, True)
