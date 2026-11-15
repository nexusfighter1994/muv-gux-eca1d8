#!/usr/bin/env python3
"""Read-only, run inside the VidForge container: catch live pc_node_normalize_cli.py calls, decode their payload and
ask the real qualify() why a call is (not) eligible for Home. Nothing is offloaded or written."""
import base64, collections, json, os, re, sys, time

sys.path.insert(0, '/app/engines/fflow/src/core')
import pc_node_normalize_cli as cli  # noqa: E402

WIN = float(sys.argv[1]) if len(sys.argv) > 1 else 60
seen, results, examples = set(), collections.Counter(), {}
end = time.time() + WIN
while time.time() < end:
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or pid in seen:
            continue
        try:
            args = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\0')
        except OSError:
            continue
        if len(args) < 3 or not any(a.endswith(b'pc_node_normalize_cli.py') for a in args):
            continue
        seen.add(pid)
        payload = next((a for a in reversed(args) if a), b'').decode('ascii', 'replace')
        try:
            request = cli.decode_request(payload)
        except Exception as exc:
            results[('undecodable', str(exc)[:40], '-', '-')] += 1
            continue
        argv = request.get('argv') or []
        vf = argv[argv.index('-vf') + 1] if '-vf' in argv else ''
        kind = ('credit+normalize' if 'drawtext' in vf and 'scale=' in vf else 'credit-only' if 'drawtext' in vf
                else 'normalize' if 'scale=' in vf else 'other')
        try:
            cli.qualify(request)
            reason = 'eligible'
        except Exception as exc:
            reason = f'{type(exc).__name__}: {exc}'[:70]
        key = (kind, reason, f'len={len(argv)}', json.dumps(request.get('options'))[:40])
        results[key] += 1
        if key not in examples:
            shown = [re.sub(r'/data/projects/[^/]+/', 'P/', a)[:150] for a in argv]
            examples[key] = shown
    time.sleep(0.15)
print('calls seen', len(seen))
for key, count in results.most_common(8):
    print(count, key)
for key, argv in list(examples.items())[:3]:
    print('EXAMPLE', key[:2])
    print('  ', argv)
