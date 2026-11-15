"""Return free glibc heap pages after tasks; never evict live objects or models."""
import ctypes
from functools import wraps
import logging
import os
from pathlib import Path
import sys
import threading
import time


def resident_bytes():
    return int(Path('/proc/self/statm').read_text().split()[1]) * os.sysconf('SC_PAGE_SIZE')


def trim_free_pages():
    if sys.platform != 'linux':
        return False
    libc = ctypes.CDLL(None)
    # malloc_trim is a glibc contract, not a generic allocator interface.
    if not hasattr(libc, 'gnu_get_libc_version'):
        return False
    trim = libc.malloc_trim
    trim.argtypes = [ctypes.c_size_t]
    trim.restype = ctypes.c_int
    return bool(trim(0))


class Reclaimer:
    def __init__(self, *, trim=trim_free_pages, rss=resident_bytes, clock=time.monotonic):
        self.trim, self.rss, self.clock = trim, rss, clock
        self.lock = threading.Lock()
        self.next_at = float('-inf')

    def release(self):
        if not self.lock.acquire(blocking=False):
            return
        try:
            now = self.clock()
            if now < self.next_at:
                return
            self.next_at = now + 60
            before = self.rss()
            if before < 256 * 1048576:
                return
            self.trim()
            after = self.rss()
            if before - after >= 16 * 1048576:
                logging.getLogger('vf-memory-reclaim').info(
                    'released free heap pages: before_mb=%.1f after_mb=%.1f',
                    before / 1048576, after / 1048576)
        except Exception:
            # Housekeeping cannot turn completed work into a failed job.
            pass
        finally:
            self.lock.release()


_reclaimer = Reclaimer()


def after_task(original, *, reclaim=None):
    if getattr(original, '__vf_memory_reclaim__', False):
        return original
    release = reclaim if reclaim is not None else _reclaimer.release

    @wraps(original)
    async def wrapped(*args, **kwargs):
        try:
            return await original(*args, **kwargs)
        finally:
            try:
                release()
            except Exception:
                pass

    wrapped.__vf_memory_reclaim__ = True
    return wrapped
