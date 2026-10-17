"""Opt-in bridge to the existing FFmpeg RateLimiter file. Does not start any worker."""
import argparse
import json
import math
import os
from pathlib import Path
import tempfile
import time
import urllib.request

ROOT = Path('E:/VidForgeHomeBoost/vf-speed-20261002')
ORIGIN = 'https://vidforge.example'
KEYS = {'downMbit', 'upMbit'}


def checked_rates(value, integer=False):
    if not isinstance(value, dict) or set(value) != KEYS:
        raise ValueError('Invalid directional bandwidth keys')
    for rate in value.values():
        if type(rate) not in (int, float) or not math.isfinite(rate) or not 0 < rate <= 1000:
            raise ValueError('Unsupported bandwidth limit; zero is not uncapped')
        if integer and (type(rate) is not int or rate < 1):
            raise ValueError('Whole Mbit/s from 1 to 1000 required')
    return dict(value)


def apply_limits(path, desired):
    path = Path(path)
    original = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(original, dict):
        raise ValueError('Existing bandwidth file is not an object')
    observed = checked_rates({key: original.get(key) for key in KEYS})
    if desired is None:
        return observed
    desired = checked_rates(desired, integer=True)
    if desired != observed:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                             prefix='.net-limits-', suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump({**original, **desired}, stream, allow_nan=False)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    observed = json.loads(path.read_text(encoding='utf-8'))
    readback = checked_rates({key: observed.get(key) for key in KEYS})
    if readback != desired:
        raise ValueError('Bandwidth file readback does not match')
    return readback


def poll_once(path, request):
    state = request('GET', '/api/pc-boost/bandwidth/bridge')
    if not isinstance(state, dict) or set(state) != {'desired', 'revision'}:
        raise ValueError('Invalid desired bandwidth response')
    observed = apply_limits(path, state['desired'])
    return request('POST', '/api/pc-boost/bandwidth/readback',
                   {'revision': state['revision'], 'observed': observed})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def remote_request(token_file):
    # Only the fixed HTTPS origin receives the existing token; no proxy or redirect.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def request(method, endpoint, body=None):
        if endpoint not in ('/api/pc-boost/bandwidth/bridge', '/api/pc-boost/bandwidth/readback'):
            raise ValueError('Unsupported endpoint')
        token = Path(token_file).read_text(encoding='utf-8').strip()
        if not token or len(token) > 4096 or '\r' in token or '\n' in token:
            raise ValueError('Authentication unavailable')
        payload = None if body is None else json.dumps(body, allow_nan=False).encode('utf-8')
        req = urllib.request.Request(ORIGIN + endpoint, data=payload, method=method,
            headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json',
                     'Content-Type': 'application/json'})
        with opener.open(req, timeout=6) as response:
            data = response.read(65537)
            if len(data) > 65536:
                raise ValueError('Response limit exceeded')
            return json.loads(data)
    return request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    request = remote_request(ROOT / 'private' / 'pc-boost-token.txt')
    while True:
        try:
            poll_once(ROOT / 'ffmpeg' / 'runtime' / 'net-limits.json', request)
            if args.once:
                print('Bandwidth file readback confirmed; runtime throughput not measured.')
                return 0
        except Exception:
            # Never print headers, response bodies, file contents or credential-bearing exceptions.
            if args.once:
                print('Bandwidth bridge unavailable; inspect connectivity and saved caps privately.')
                return 1
        time.sleep(5)


if __name__ == '__main__':
    raise SystemExit(main())
