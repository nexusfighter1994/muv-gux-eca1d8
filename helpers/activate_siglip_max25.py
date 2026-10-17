"""Drain/reload only the verified local SigLIP service; never touches SSH/FFmpeg."""
import datetime
import argparse
import http.client
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path('E:/VidForgeHomeBoost/vf-speed-20261002/siglip')
JUNCTION = Path('C:/Users/user/Documents/Codex/2026-07-04/du-bist-codex-auf-users-windows/vf-speed-20261002/siglip')
FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
GATE = ROOT / 'runtime' / 'siglip-maintenance.json'


def powershell(command):
    result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=15, creationflags=FLAGS)
    if result.returncode:
        raise RuntimeError('Local process inspection/action failed')
    return result.stdout.strip()


def service_identity(record):
    if record.get('Name', '').lower() != 'python.exe':
        return False
    command = record.get('CommandLine', '').lower()
    return any(str(root / 'service.py').replace('/', '\\').lower() in command for root in (ROOT, JUNCTION))


def safe_to_stop(record, expected, active, draining):
    return (service_identity(record) and record.get('ProcessId') == expected.get('ProcessId')
            and record.get('Started') == expected.get('Started') and type(active) is int
            and active == 0 and draining is True)


def inventory():
    raw = powershell("Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
        "Where-Object { $_.CommandLine -match '[\\\\/]siglip[\\\\/]service\\.py' } | "
        "ForEach-Object { [pscustomobject]@{ProcessId=$_.ProcessId;ParentProcessId=$_.ParentProcessId;Name=$_.Name;"
        "CommandLine=$_.CommandLine;Started=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress")
    data = json.loads(raw) if raw else []
    return data if isinstance(data, list) else [data]


def request(method, path, token, body=None, port=18194, expected_owner=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=6)
    try:
        connection.connect()
        client_port = connection.sock.getsockname()[1]
        owner = powershell(f"Get-NetTCPConnection -State Established -LocalPort {port} -RemotePort {client_port} "
                           "-ErrorAction Stop | Select-Object -ExpandProperty OwningProcess | ConvertTo-Json -Compress")
        owner = json.loads(owner)
        if type(owner) is not int:
            raise RuntimeError('Ambiguous SigLIP connection owner')
        if expected_owner is not None and owner != expected_owner:
            return owner, 0, {}
        payload = None if body is None else json.dumps(body, allow_nan=False)
        connection.request(method, path, payload, {'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json', 'X-VF-Local': '1'})
        response = connection.getresponse()
        data = response.read(65537)
        if len(data) > 65536:
            raise RuntimeError('Local response too large')
        return owner, response.status, json.loads(data)
    finally:
        connection.close()


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(data, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def launch_hidden(command, log_path, timeout):
    # Persistent grandchildren can inherit capture pipes and prevent communicate() finishing.
    with Path(log_path).open('a', encoding='utf-8') as log:
        flags = FLAGS | getattr(subprocess, 'CREATE_BREAKAWAY_FROM_JOB', 0)
        try:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log,
                                       stderr=subprocess.STDOUT, creationflags=flags)
        except PermissionError:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log,
                                       stderr=subprocess.STDOUT, creationflags=FLAGS)
        return process.wait(timeout=timeout)


def wait_ready(token, port, timeout=240, require_transfer=False):
    deadline = time.monotonic() + timeout
    keys = {'ffmpegMaxFileMb', 'ffmpegMaxTotalMb', 'sceneMaxFileMb', 'siglipMaxImageMb'}
    while time.monotonic() < deadline:
        try:
            owner, status, health = request('GET', '/health', token, port=port)
            if status == 200 and health.get('ready') is True:
                if require_transfer and set(health.get('transferLimits', {})) != keys:
                    raise RuntimeError('Ready worker is missing transfer-limit guards')
                return owner, status, health
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(1)
    raise RuntimeError('Service readiness deadline; no process was killed')


def start_then_ready(command, log_path, token, port, timeout, require_transfer=False):
    try:
        result = launch_hidden(command, log_path, timeout)
    except subprocess.TimeoutExpired:
        result = 'starter_wait_timeout'
    if result:
        print(json.dumps({'starterExit': result, 'waitingForSpawnedService': True}), flush=True)
    return wait_ready(token, port, require_transfer=require_transfer)


def stop_verified(expected, active, draining):
    current = next((item for item in inventory() if item['ProcessId'] == expected['ProcessId']), None)
    if not current or not safe_to_stop(current, expected, active, draining):
        raise RuntimeError('Refusing to stop an unverified/non-idle process')
    pid = expected['ProcessId']
    # Reverify creation time and the exact service command inside the stopping process.
    started = expected['Started']
    command_path = str(ROOT / 'service.py').replace("'", "''")
    junction_path = str(JUNCTION / 'service.py').replace("'", "''")
    powershell(f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; "
        f"if(-not $p -or $p.Name -ne 'python.exe' -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '{started}' "
        f"-or (-not $p.CommandLine.Contains('{command_path}') -and -not $p.CommandLine.Contains('{junction_path}'))) "
        "{throw 'Identity mismatch'}; " + f"Stop-Process -Id {pid} -ErrorAction Stop")


def main(require_transfer=False):
    records = [item for item in inventory() if service_identity(item)]
    service_pids = {item['ProcessId'] for item in records}
    children = {item['ProcessId']: item for item in records if item['ParentProcessId'] in service_pids}
    if not children:
        raise RuntimeError('No verified SigLIP listener process tree')
    token = (ROOT.parent / 'private' / 'pc-boost-token.txt').read_text().strip()
    owner, status, original = request('GET', '/config', token)
    if status != 200 or owner not in children:
        raise RuntimeError('Unexpected live config owner')
    # Capture actual selections, never replace them with intended12 or old defaults.
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    evidence = ROOT / 'runtime' / (('transfer-activation-' if require_transfer else 'max25-activation-') + stamp)
    initial_file = evidence / 'initial-config.json'
    atomic_json(initial_file, original)
    atomic_json(evidence / 'before.json', {'processes': [{k: v for k, v in item.items() if k != 'CommandLine'}
        for item in records], 'config': original})
    atomic_json(GATE, {'expiresAt': int(time.time()) + 600})
    stopped = []
    try:
        deadline = time.monotonic() + 300
        drain = {**original, 'siglipEnabled': False}
        while children:
            if time.monotonic() > deadline:
                raise RuntimeError('SigLIP drain deadline reached; no forced busy termination')
            owner, status, applied = request('PUT', '/config', token, drain)
            if status != 200 or owner not in children:
                raise RuntimeError('Unexpected drain/config owner')
            health_owner, status, health = request('GET', '/health', token)
            config_owner, config_status, current = request('GET', '/config', token)
            active = health.get('active_tasks')
            print(json.dumps({'drainPid': owner, 'healthPid': health_owner, 'active': active,
                              'sameInstance': owner == health_owner == config_owner}), flush=True)
            if (status == 200 and config_status == 200 and owner == health_owner == config_owner
                    and current.get('siglipEnabled') is False and active == 0):
                stop_verified(children[owner], active, True)
                stopped.append(owner)
                del children[owner]
                print(json.dumps({'stoppedIdleSiglipPid': owner, 'activeAtStop': 0}), flush=True)
                time.sleep(0.3)
            else:
                time.sleep(0.5)
        owner, status, health = start_then_ready(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            str(ROOT / 'start.ps1'), '-MaintenanceStart', '-InitialConfigPath', str(initial_file)],
            evidence / 'startup.log', token, 18194, 110, require_transfer)
        if require_transfer:
            _, limits_status, readback = request('GET', '/transfer-limits', token)
            if limits_status != 200 or readback != {'limits': health['transferLimits']}:
                raise RuntimeError('Transfer limits do not match actual health')
        _, _, before_validation = request('GET', '/config', token)
        tests = []
        for value, expected_status in ((12, 200), (25, 200), (26, 400)):
            checked_owner, checked_status, body = request('POST', '/config/validate', token, {'siglipConcurrency': value})
            if checked_owner != owner or checked_status != expected_status:
                raise RuntimeError('Live numeric validator/readback mismatch')
            tests.append({'value': value, 'status': checked_status})
        _, _, after_validation = request('GET', '/config', token)
        if after_validation != before_validation:
            raise RuntimeError('Config changed during validation; inspect native sync without overwriting')
        outcome = {'ready': health.get('ready'), 'pid': owner, 'configured': health.get('configured_concurrency'),
            'active': health.get('active_tasks'), 'config': after_validation, 'validation': tests,
            'transferLimits': health.get('transferLimits'), 'configPreserved': after_validation == original,
            'stoppedIdlePids': stopped, 'evidence': str(evidence)}
        atomic_json(evidence / 'verified.json', outcome)
        print(json.dumps(outcome), flush=True)
    except Exception:
        # Restore admission on surviving old services; do not kill or reset unrelated processes.
        if children:
            try:
                request('PUT', '/config', token, original)
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
