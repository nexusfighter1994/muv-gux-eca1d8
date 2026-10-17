import http.client
import importlib.util
import json
import sys
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1].parent / 'vf-speed-20261002' / 'ffmpeg'
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('ffmpeg_worker', ROOT / 'pc_ffmpeg_worker.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
CURRENT = dict(enabled=True, cpuWorkers=12, gpuWorkers=0, siglipEnabled=True, siglipConcurrency=12, sceneWorkers=0)


class ControlsTests(unittest.TestCase):
    def test_startup_configuration_preserves_current_choices(self):
        self.assertTrue(callable(getattr(service, 'initial_config', None)))
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'config.json'
            file.write_text(json.dumps(CURRENT))
            self.assertEqual(service.initial_config(file), CURRENT)
            file.write_text('{broken')
            with self.assertRaises(ValueError):
                service.initial_config(file)

    def test_live_validation_is_nonmutating_25accepted26rejected_for_all_four_fields(self):
        class Worker:
            token = 'test-only-token'
            lock = threading.RLock()
            config = dict(CURRENT)
        worker = Worker()
        server = service.make_server(worker, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for key in ('cpuWorkers', 'gpuWorkers', 'siglipConcurrency', 'sceneWorkers'):
                for value, expected in ((25, 200), (26, 400)):
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    connection.request('POST', '/config/validate', json.dumps({key: value}),
                        {'Authorization': 'Bearer test-only-token', 'Content-Type': 'application/json', 'X-VF-Local': '1'})
                    response = connection.getresponse()
                    body = json.loads(response.read())
                    connection.close()
                    self.assertEqual(response.status, expected)
                    if expected == 200:
                        self.assertEqual(body['proposed'][key], value)
                    self.assertEqual(worker.config, CURRENT)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_hidden_starter_reads_only_its_maintenance_gate_and_preserves_config(self):
        source = (ROOT / 'start.ps1').read_text()
        self.assertIn('ffmpeg-maintenance.json', source)
        self.assertIn('$MaintenanceStart', source)
        self.assertIn('$InitialConfigPath', source)
        self.assertIn('$existingWorkers', source)
        self.assertIn('bootstrap still running', source)

    def test_reload_never_replaces_new_user_selections_with_historical12(self):
        source = (ROOT.parent.parent / 'vf-custom' / 'helpers' / 'activate_ffmpeg_max25.py').read_text()
        self.assertIn('desired = dict(original_config)', source)
        self.assertIn('start_then_ready', source)

    def test_bootstrap_guard_actually_defers_duplicate_launch_with_mocked_process_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / 'test-token.txt'
            token.write_text('test-only-token')
            command = (
                "function Invoke-RestMethod { throw 'fixture offline' }; "
                "function Get-CimInstance { [pscustomobject]@{Name='python.exe'; "
                f"CommandLine='python.exe \"{ROOT / 'pc_ffmpeg_worker.py'}\" --port 18191'}} }}; "
                "function Get-NetTCPConnection { throw 'Unexpected listener query' }; "
                "function Start-Process { throw 'Unexpected duplicate launch' }; "
                f"& '{ROOT / 'start.ps1'}' -TokenFile '{token}'")
            result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', command],
                capture_output=True, text=True, timeout=15,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('bootstrap still running', result.stdout)


if __name__ == '__main__':
    unittest.main()
