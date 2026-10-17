"""Keep the native FX runner's one owned output directory nonempty until cleanup."""
import asyncio
import os
from pathlib import Path
import re
import stat

try:
    from .mod_flags import mod_enabled
except ImportError:
    from mod_flags import mod_enabled


TEMP_ROOT = Path('/data/engines/fflow/tmp')
MARKER_NAME = '.vf-fx-active'


def protect_fx_output(spec, *, temp_root=None):
    try:
        task = asyncio.current_task()
    except RuntimeError:
        task = None
    if task is not None and task.cancelling():
        raise asyncio.CancelledError()
    if not mod_enabled('fxSentinel'):
        return None
    root = Path(temp_root) if temp_root is not None else TEMP_ROOT
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError('FX temp root must be an existing real directory')
    root = root.resolve(strict=True)
    if not isinstance(spec, dict) or not isinstance(spec.get('output'), str) or not isinstance(spec.get('input'), str):
        raise ValueError('FX spec paths are required')
    output, source = Path(spec['output']), Path(spec['input'])
    directory = output.parent
    if (not output.is_absolute() or '..' in output.parts or output.name != 'windows.mp4'
            or directory.parent != root or not re.fullmatch(r'fx-out-[a-z0-9_]{8}', directory.name)
            or not source.is_absolute() or source.resolve().is_relative_to(directory)):
        raise ValueError('FX output is not the exact native owned temporary path')
    marker = directory / MARKER_NAME
    for _ in range(3):
        try:
            if directory.is_symlink():
                raise ValueError('FX output directory must not be a symlink')
            directory.mkdir(exist_ok=True)
            if directory.resolve(strict=True) != directory:
                raise ValueError('FX output directory escaped its native root')
            for entry in directory.iterdir():
                if entry.name not in (MARKER_NAME, 'windows.mp4'):
                    raise ValueError('FX output directory already contains unknown assets')
                if entry.name == 'windows.mp4':
                    info = entry.lstat()
                    if (not stat.S_ISREG(info.st_mode)
                            or (hasattr(os, 'getuid') and info.st_uid != os.getuid())
                            or (source.exists() and entry.samefile(source))):
                        raise ValueError('FX existing output is not an owned regular native output')
            try:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
                descriptor = os.open(marker, flags, 0o600)
            except FileExistsError:
                info = marker.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_size != 0 or (hasattr(os, 'getuid') and info.st_uid != os.getuid()):
                    raise ValueError('FX sentinel is not an owned empty regular file')
            else:
                os.close(descriptor)
            return marker
        except FileNotFoundError:
            # The original janitor may remove the empty directory between mkdir and open.
            continue
    raise RuntimeError('FX owned output directory disappeared during bounded sentinel creation')
