"""Idle-only reload of the local PC worker; no manual FFmpeg/SSH process actions."""
import datetime
import argparse
import json
from pathlib import Path
import subprocess
import time

from activate_siglip_max25 import atomic_json, powershell, request, start_then_ready

ROOT = Path('E:/VidForgeHomeBoost/vf-speed-20261002/ffmpeg')
GATE = ROOT / 'runtime' / 'ffmpeg-maintenance.json'
SERVICE = str(ROOT / 'pc_ffmpeg_worker.py')


def identity(pid):
    raw = powershell(f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; "
        "if($p){[pscustomobject]@{ProcessId=$p.ProcessId;Name=$p.Name;CommandLine=$p.CommandLine;"
        "Started=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}")
    return json.loads(raw) if raw else None


def is_worker(record):
    return (record and record.get('Name') == 'python.exe' and
            SERVICE.lower() in record.get('CommandLine', '').lower())


def safe_to_stop(current, original, health, pending):
    return (is_worker(current) and current['ProcessId'] == original['ProcessId']
        and current['Started'] == original['Started']
        and all(health.get(key) == 0 for key in ('cpuBusy', 'gpuBusy', 'sceneBusy'))
        and pending == 0)


def pending_requests(pid):
    count = powershell(f"@(Get-NetTCPConnection -LocalPort 18191 -State Established -ErrorAction SilentlyContinue "
                       f"| Where-Object {{$_.OwningProcess -eq {pid}}}).Count")
    partials = list((ROOT / 'runtime' / 'blobs').glob('.blob-*'))
    fresh = sum(time.time() - file.stat().st_mtime < 30 for file in partials)
    return int(count) + fresh


def main(require_transfer=False):
    token = (ROOT.parent / 'private' / 'pc-boost-token.txt').read_text().strip()
    pid, status, original_config = request('GET', '/config', token, port=18191)
    old = identity(pid)
    if status != 200 or not is_worker(old):
        raise RuntimeError('Unverified PC worker listener')
    desired = dict(original_config)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    evidence = ROOT / 'runtime' / (('transfer-activation-' if require_transfer else 'max25-activation-') + stamp)
    initial_file = evidence / 'initial-config.json'
    atomic_json(initial_file, desired)
    atomic_json(evidence / 'before.json', {**{key: value for key, value in old.items() if key != 'CommandLine'},
                                          'runtimeConfig': original_config, 'desiredConfig': desired})
    atomic_json(GATE, {'expiresAt': int(time.time()) + 600})
    stopped = False
    try:
        # This admission gate is local only; persisted owner selections are not changed.
        drain = {**original_config, 'enabled': False, 'cpuWorkers': 0, 'gpuWorkers': 0, 'sceneWorkers': 0}
        owner, status, _ = request('PUT', '/config', token, drain, port=18191)
        if owner != pid or status != 200:
            raise RuntimeError('PC admission gate failed')
        started = time.monotonic()
        quiet = 0
        while time.monotonic() - started < 240:
            request('PUT', '/config', token, drain, port=18191)
            owner, status, health = request('GET', '/health', token, port=18191)
            pending = pending_requests(pid)
            idle = owner == pid and status == 200 and safe_to_stop(identity(pid), old, health, pending)
            quiet = quiet + 1 if idle else 0
            print(json.dumps({'workerPid': pid, 'cpuBusy': health.get('cpuBusy'), 'gpuBusy': health.get('gpuBusy'),
                'sceneBusy': health.get('sceneBusy'), 'pendingHTTPorBlob': pending, 'quietSamples': quiet}), flush=True)
            if quiet >= 3 and time.monotonic() - started >= 25:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Worker drain timeout; refusing busy termination')
        owner, _, health = request('GET', '/health', token, port=18191)
        if owner != pid or not safe_to_stop(identity(pid), old, health, pending_requests(pid)):
            raise RuntimeError('Worker became busy; stop aborted')
        source = SERVICE.replace("'", "''")
        powershell(f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; "
            f"if(-not $p -or $p.Name -ne 'python.exe' -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '{old['Started']}' "
            f"-or -not $p.CommandLine.Contains('{source}')){{throw 'Identity changed'}}; Stop-Process -Id {pid} -ErrorAction Stop")
        stopped = True
        print(json.dumps({'stoppedIdleWorkerPid': pid, 'pendingTransfersAtStop': 0}), flush=True)
        command = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ROOT / 'start.ps1'),
                   '-MaintenanceStart', '-InitialConfigPath', str(initial_file)]
        owner, _, health = start_then_ready(command, evidence / 'startup.log', token, 18191, 90, require_transfer)
        if require_transfer:
            _, limits_status, readback = request('GET', '/transfer-limits', token, port=18191)
            if limits_status != 200 or readback != {'limits': health['transferLimits']}:
                raise RuntimeError('Transfer limits do not match actual health')
        _, _, before = request('GET', '/config', token, port=18191)
        checks = []
        for key in ('cpuWorkers', 'gpuWorkers', 'siglipConcurrency', 'sceneWorkers'):
            for value, expected_status in ((25, 200), (26, 400)):
                validator_owner, status, _ = request('POST', '/config/validate', token, {key: value}, port=18191)
                if validator_owner != owner or status != expected_status:
                    raise RuntimeError('Live worker validator mismatch')
                checks.append({'field': key, 'value': value, 'status': status})
        _, _, after = request('GET', '/config', token, port=18191)
        if after != before:
            raise RuntimeError('Native config changed during checks; inspect, never overwrite')
        outcome = {'ready': health.get('ready'), 'pid': owner, 'config': after, 'validation': checks,
                   'transferLimits': health.get('transferLimits'), 'configPreserved': after == original_config,
                   'stoppedPid': pid, 'evidence': str(evidence)}
        atomic_json(evidence / 'verified.json', outcome)
        print(json.dumps(outcome), flush=True)
    except Exception:
        if not stopped:
            # Still-old worker can accept only old schema; do not leave local CPU admission off.
            try:
                request('PUT', '/config', token, original_config, port=18191)
            except Exception:
                pass
        raise
    finally:
        GATE.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--transfer-limits', action='store_true')
        main(parser.parse_args().transfer_limits)
    except Exception as error:
        print(json.dumps({'failed': type(error).__name__, 'message': str(error)}), flush=True)
        raise SystemExit(1)
