"""GET-only desired-rate mirror. A local file is never proof of server TC state."""
import argparse
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import datetime
import json
import os
from pathlib import Path
import tempfile
import time
import uuid

from pc_boost_bandwidth_bridge import ROOT, apply_limits, checked_rates, remote_request

ENDPOINT = '/api/pc-boost/bandwidth/bridge'
LIMITS = ROOT / 'ffmpeg' / 'runtime' / 'net-limits.json'
STATUS = ROOT / 'ffmpeg' / 'runtime' / 'bandwidth-mirror-status.json'
SCOPE = 'local_ffmpeg_file_only'


def poll_once(path, request):
    state = request('GET', ENDPOINT)
    if not isinstance(state, dict) or set(state) != {'desired', 'revision'}:
        raise ValueError('Invalid desired bandwidth response')
    desired, revision = state['desired'], state['revision']
    if desired is None:
        # Unmanaged keeps the existing120/37 fallback; never resets a previously selected cap.
        return {'managed': False, 'revision': revision, 'observed': None, 'scope': SCOPE}
    if not isinstance(revision, str) or str(uuid.UUID(revision)) != revision:
        raise ValueError('Invalid bandwidth revision')
    desired = checked_rates(desired, integer=True)
    observed = apply_limits(path, desired)
    return {'managed': True, 'revision': revision, 'observed': observed, 'scope': SCOPE}


@contextmanager
def single_instance(name='Local\\VidForgeBandwidthDesiredMirror20261011'):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.ReleaseMutex.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.CreateMutexW(None, False, name)
    if not handle:
        raise OSError('Mirror singleton unavailable')
    acquired = kernel.WaitForSingleObject(handle, 0) in (0, 128)
    try:
        yield acquired
    finally:
        if acquired:
            kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


def save_status(path, state):
    path = Path(path)
    descriptor, name = tempfile.mkstemp(prefix='.bandwidth-mirror-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(state, stream, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    # Existing transport: fixed HTTPS origin,6s timeout,64KiB response limit,
    # no proxies/redirects and private bearer file. This module calls GET only.
    request = remote_request(ROOT / 'private' / 'pc-boost-token.txt')
    with single_instance() as acquired:
        if not acquired:
            print('Desired-rate mirror already running.', flush=True)
            return 0
        previous = None
        while True:
            try:
                result = poll_once(LIMITS, request)
                state = {**result, 'pid': os.getpid(), 'healthy': True,
                         'polledAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
                save_status(STATUS, state)
                if result != previous:
                    print(json.dumps(result, allow_nan=False), flush=True)
                    previous = result
                if args.once:
                    return 0
            except Exception:
                # No response body, token, header or credential-bearing exception is logged.
                print('Desired-rate mirror unavailable; existing caps retained.', flush=True)
                if args.once:
                    return 1
            time.sleep(5)


if __name__ == '__main__':
    raise SystemExit(main())
