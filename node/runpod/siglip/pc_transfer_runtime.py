"""Local-only atomic storage; callers always pass their own worker runtime path."""
import json
import os
from pathlib import Path
import tempfile
import threading

from pc_transfer_limits import DEFAULT_LIMITS, read_limits, validate_limits


class TransferLimits:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()

    def get(self):
        with self.lock:
            return read_limits(self.path, max_age=0)

    def set(self, update):
        if not isinstance(update, dict) or set(update) != set(DEFAULT_LIMITS):
            raise ValueError('Expected exactly four transfer limits')
        limits = validate_limits(update)
        with self.lock:
            if self.path.is_symlink():
                raise ValueError('Transfer limits must be a regular file')
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix='.transfer-', suffix='.tmp', dir=self.path.parent)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                    json.dump(limits, stream, allow_nan=False)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(name, self.path)
            finally:
                Path(name).unlink(missing_ok=True)
            return self.get()
