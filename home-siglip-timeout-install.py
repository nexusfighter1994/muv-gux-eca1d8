"""Raise Home SigLIP service time limits (2026-11-12): first GPU turn 75 -> 240 s, request budget 120 -> 300 s.
Server-side fetch timeout is 600 s (home-load-timeouts.cjs SIGLIP_MS), so both stay well inside it.
Usage: python siglip-timeout-patch.py <service.py> [...]"""
import shutil, sys
from pathlib import Path

MARK = 'vf-custom:siglip-timeout-300-v1'
EDITS = [
    ("    def rank(self, query, candidates, timeout=120, options=None, mode=TEXT_MODE_SIGLIP2, limits=None):\n",
     "    def rank(self, query, candidates, timeout=300, options=None, mode=TEXT_MODE_SIGLIP2, limits=None):\n"),
    ("        # The GPU lock is held per batch, so concurrent requests interleave: a request waits at\n"
     "        # most 75 s for its first GPU turn and must finish inside the sender's 120 s.\n",
     "        # The GPU lock is held per batch, so concurrent requests interleave: a request waits at\n"
     "        # most 240 s for its first GPU turn and must finish inside 300 s (sender aborts at 600 s).\n"
     "        # " + MARK + " (2026-11-12): at 75/120 s a full queue (20 in flight) timed out almost every\n"
     "        # request (GPU 86-95 % busy, ~0 completed/min, server recomputed natively).\n"),
    ("            left = min(started + min(timeout, 75), started + timeout - 10) - time.monotonic() if not results else started + timeout - 10 - time.monotonic()\n",
     "            left = min(started + min(timeout, 240), started + timeout - 10) - time.monotonic() if not results else started + timeout - 10 - time.monotonic()\n"),
]

for path in map(Path, sys.argv[1:]):
    raw = path.read_bytes()
    text = raw.decode('utf-8').replace('\r\n', '\n')
    if MARK in text:
        print(path, 'already'); continue
    for old, new in EDITS:
        if text.count(old) != 1:
            raise SystemExit(f'{path}: anchor found {text.count(old)} times')
        text = text.replace(old, new)
    compile(text, str(path), 'exec')
    backup = path.with_name(path.name + '.before-timeout300-20261112')
    if not backup.exists():
        shutil.copy2(path, backup)
    if b'\r\n' in raw:
        text = text.replace('\n', '\r\n')
    path.write_bytes(text.encode('utf-8'))
    print(path, 'patched')
