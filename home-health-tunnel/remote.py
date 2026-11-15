"""Manage only the two private VidForge status-forward socket paths."""
import errno
import json
import os
from pathlib import Path
import socket
import stat
import sys


ROOT = Path('/var/lib/docker/volumes/aufsetzen-apps_vidforge-data/_data/runtime')
NAMES = ('home-health-ffmpeg.sock', 'home-health-siglip.sock')
GROUPS = {'health': NAMES, 'ocr': ('home-ocr.sock',),
          'validation': ('home-motion-validation.sock',)}


def identity(path):
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid not in (0, 10001):
        raise RuntimeError('unexpected socket identity')
    return info.st_dev, info.st_ino, info.st_uid


def probe(path):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(1)
        client.connect(str(path))


def prepare_socket(path):
    try:
        before = identity(path)
    except FileNotFoundError:
        return 'absent'
    try:
        probe(path)
    except OSError as error:
        if error.errno != errno.ECONNREFUSED:
            raise
        try:
            after = identity(path)
        except (FileNotFoundError, RuntimeError) as changed:
            raise RuntimeError('socket changed during check') from changed
        if after != before:
            raise RuntimeError('socket changed during check')
        path.unlink()
        return 'removed-stale'
    raise RuntimeError('live socket belongs to an existing tunnel')


def verify_socket(path):
    before = identity(path)
    probe(path)
    if identity(path) != before:
        raise RuntimeError('socket changed during verification')
    os.chown(path, 10001, 10001, follow_symlinks=False)
    os.chmod(path, 0o660, follow_symlinks=False)


def main():
    if (len(sys.argv) != 3 or sys.argv[1] not in ('prepare', 'verify')
            or sys.argv[2] not in GROUPS):
        raise SystemExit('Expected prepare/verify and health/ocr/validation')
    action = prepare_socket if sys.argv[1] == 'prepare' else verify_socket
    for name in GROUPS[sys.argv[2]]:
        result = action(ROOT / name)
        print(json.dumps({'socket': name, 'state': result or 'verified'}))


if __name__ == '__main__':
    main()
