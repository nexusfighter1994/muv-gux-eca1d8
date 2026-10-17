"""Remove only an explicitly identified duplicate listener after an idle drain."""
import argparse
import datetime
import json
from pathlib import Path
import time

from activate_siglip_max25 import atomic_json, powershell, request

ROOT = Path('E:/VidForgeHomeBoost/vf-speed-20261002/ffmpeg')
JUNCTION = Path('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/vf-speed-20261002/ffmpeg')


def record(pid):
    raw = powershell(f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; "
        "if($p){[pscustomobject]@{PID=$p.ProcessId;Name=$p.Name;CommandLine=$p.CommandLine;"
        "Started=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}")
    return json.loads(raw) if raw else None


def verified(value, pid, started):
    return bool(value and value['PID'] == pid and value['Started'] == started and value['Name'] == 'python.exe'
        and any(str(root / 'pc_ffmpeg_worker.py').lower() in value['CommandLine'].lower() for root in (ROOT, JUNCTION)))


def main(pid, started):
    token = (ROOT.parent / 'private' / 'pc-boost-token.txt').read_text().strip()
    initial = record(pid)
    if not verified(initial, pid, started):
        raise RuntimeError('Duplicate worker identity mismatch')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    evidence = ROOT / 'runtime' / ('duplicate-drain-' + stamp)
    deadline = time.monotonic() + 240
    original = None
    stopped = False
    try:
        while time.monotonic() < deadline:
            _, status, config = request('GET', '/config', token, port=18191, expected_owner=pid)
            if status == 200:
                original = config
                break
        if original is None:
            raise RuntimeError('Cannot reach exact duplicate listener')
        atomic_json(evidence / 'before.json', {'pid': pid, 'started': started, 'config': original})
        drain = {**original, 'enabled': False, 'cpuWorkers': 0, 'gpuWorkers': 0, 'sceneWorkers': 0}
        quiet = 0
        began = time.monotonic()
        while time.monotonic() < deadline:
            _, applied, _ = request('PUT', '/config', token, drain, port=18191, expected_owner=pid)
            if applied != 200:
                continue
            _, status, health = request('GET', '/health', token, port=18191, expected_owner=pid)
            pending = int(powershell(f"@(Get-NetTCPConnection -LocalPort 18191 -State Established -ErrorAction SilentlyContinue "
                                    f"| Where-Object {{$_.OwningProcess -eq {pid}}}).Count"))
            idle = (status == 200 and health.get('config', {}).get('enabled') is False and pending == 0
                    and all(health.get(key) == 0 for key in ('cpuBusy', 'gpuBusy', 'sceneBusy')))
            quiet = quiet + 1 if idle else 0
            print(json.dumps({'duplicatePid': pid, 'cpuBusy': health.get('cpuBusy'), 'pendingHTTP': pending,
                              'quietSamples': quiet}), flush=True)
            if quiet >= 3 and time.monotonic() - began >= 25:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Duplicate drain timeout; refusing busy termination')
        _, status, health = request('GET', '/health', token, port=18191, expected_owner=pid)
        if (status != 200 or health['config']['enabled'] is not False
                or any(health.get(key) != 0 for key in ('cpuBusy', 'gpuBusy', 'sceneBusy'))
                or not verified(record(pid), pid, started)):
            raise RuntimeError('Final duplicate idle/identity check failed')
        source = initial['CommandLine']
        exact = next(str(root / 'pc_ffmpeg_worker.py') for root in (ROOT, JUNCTION) if str(root / 'pc_ffmpeg_worker.py') in source)
        powershell(f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; "
            f"if(-not $p -or $p.Name -ne 'python.exe' -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '{started}' "
            f"-or -not $p.CommandLine.Contains('{exact}')){{throw 'Identity changed'}}; "
            f"if(@(Get-NetTCPConnection -LocalPort 18191 -State Established -ErrorAction SilentlyContinue | "
            f"Where-Object {{$_.OwningProcess -eq {pid}}}).Count -ne 0){{throw 'Pending duplicate HTTP'}}; "
            f"Stop-Process -Id {pid} -ErrorAction Stop")
        stopped = True
        outcome = {'stoppedOnlyDuplicatePid': pid, 'cpuBusyAtStop': 0, 'gpuBusyAtStop': 0,
                   'sceneBusyAtStop': 0, 'pendingHTTPAtStop': 0, 'evidence': str(evidence)}
        atomic_json(evidence / 'verified.json', outcome)
        print(json.dumps(outcome), flush=True)
    finally:
        if original is not None and not stopped:
            request('PUT', '/config', token, original, port=18191, expected_owner=pid)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--started', required=True)
    args = parser.parse_args()
    main(args.pid, args.started)
