"""Generous Home offload timeouts in pc_ffmpeg_hook.py (owner 2026-11-12: "timeouts großzügiger").

vf-custom:home-hook-timeouts-v1
- control requests (submit/status/blob checks): 5 -> 15 s. After the 12.11. API restarts the saturated
  server answered slowly and 45-55 % of Home trims fell back natively with "TimeoutError: timed out" (ctl_to).
- keep-alive status read 5 -> 10 s (interval stays 6 s; Home reaps after 20 s idle).
- Home /health: 15/5 -> 30/15 s.
- whole Home offload deadline: home-scoped 420 -> 900 s, other 210 -> 420 s (FFlow's own timeout still wins).
- Home ffmpeg job timeout cap 180 -> 360 s.
- result download read timeout 30 -> 90 s.
Usage: python3 hook-timeouts-install.py <pc_ffmpeg_hook.py> [...]; idempotent, backup *.before-hook-timeouts-20261112.
"""
import shutil, sys
from pathlib import Path

MARK = 'vf-custom:home-hook-timeouts-v1'
EDITS = [
    ("def http_request(url, token, method, path, data=None, timeout=5):\n",
     "# " + MARK + " (2026-11-12): control timeouts 5 -> 15 s, health 30/15 s, deadlines 900/420 s,\n"
     "# Home job cap 360 s, download read 90 s. Owner: generous timeouts; 5 s control calls fell back\n"
     "# natively (ctl_to 45-55 %) while the API was saturated after restarts.\n"
     "def http_request(url, token, method, path, data=None, timeout=15):\n"),
    ("def direct_request(url, token, method, path, data=None, timeout=5):\n",
     "def direct_request(url, token, method, path, data=None, timeout=15):\n"),
    ("'/blobs/' + reference['sha256'], None, 5).get('present')",
     "'/blobs/' + reference['sha256'], None, 15).get('present')"),
    ("'/renders/' + identifier + '?metadata=1', None, 5)\n",
     "'/renders/' + identifier + '?metadata=1', None, 10)\n"),
    ("'/health', None, 15 if attempts > 1 else 5)",
     "'/health', None, 30 if attempts > 1 else 15)"),
    ("HOME_RENDER_DEADLINE_S = 420\n", "HOME_RENDER_DEADLINE_S = 900\n"),
    ("    cap = HOME_RENDER_DEADLINE_S if home_scoped() else 210\n",
     "    cap = HOME_RENDER_DEADLINE_S if home_scoped() else 420\n"),
    ("payload['timeout'] = min(180, max(1, float(timeout or 180)))",
     "payload['timeout'] = min(360, max(1, float(timeout or 360)))"),
    ("with opener.open(request, timeout=30) as response, open(temporary, 'wb') as stream:",
     "with opener.open(request, timeout=90) as response, open(temporary, 'wb') as stream:"),
]

for path in map(Path, sys.argv[1:]):
    raw = path.read_bytes()
    text = raw.decode('utf-8').replace('\r\n', '\n')
    if MARK in text:
        print(path, 'already'); continue
    for old, new in EDITS:
        if text.count(old) != 1:
            raise SystemExit(f'{path}: anchor {old[:50]!r} found {text.count(old)} times')
        text = text.replace(old, new)
    compile(text, str(path), 'exec')
    backup = path.with_name(path.name + '.before-hook-timeouts-20261112')
    if not backup.exists():
        shutil.copy2(path, backup)
    if b'\r\n' in raw:
        text = text.replace('\n', '\r\n')
    path.write_bytes(text.encode('utf-8'))
    print(path, 'patched')
