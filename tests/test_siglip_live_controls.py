import http.client
import importlib.util
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1].parent / 'vf-speed-20261002' / 'siglip'
spec = importlib.util.spec_from_file_location('siglip_service', ROOT / 'service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
CURRENT = dict(enabled=True, cpuWorkers=12, gpuWorkers=0, siglipEnabled=True, siglipConcurrency=8)


class LiveControlsTests(unittest.TestCase):
    def test_startup_state_preserves_current_choices_not_defaults_or_intended12(self):
        self.assertIn('config', __import__('inspect').signature(service.State).parameters)
        state = service.State(None, 'test-only-token', config=CURRENT)
        self.assertEqual(state.config, CURRENT)
        self.assertEqual(state.active, 0)

    def test_initial_config_file_is_validated_before_startup(self):
        self.assertTrue(callable(getattr(service, 'initial_config', None)))
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'config.json'
            file.write_text(json.dumps(CURRENT))
            self.assertEqual(service.initial_config(file), CURRENT)
            file.write_text('{broken')
            with self.assertRaises(ValueError):
                service.initial_config(file)

    def test_live_validation_accepts12_and25_rejects26_without_assigning_or_inferencing(self):
        state = service.State(None, 'test-only-token')
        state.config = dict(CURRENT)
        server = ThreadingHTTPServer(('127.0.0.1', 0), service.Handler)
        server.state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for value, status in ((12, 200), (25, 200), (26, 400)):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                connection.request('POST', '/config/validate', json.dumps({'siglipConcurrency': value}),
                    {'Authorization': 'Bearer test-only-token', 'Content-Type': 'application/json'})
                response = connection.getresponse()
                body = json.loads(response.read())
                connection.close()
                self.assertEqual(response.status, status)
                if status == 200:
                    self.assertTrue(body['valid'])
                    self.assertEqual(body['proposed']['siglipConcurrency'], value)
                self.assertEqual(state.config, CURRENT)
                self.assertEqual(state.active, 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_hidden_starter_has_single_instance_and_maintenance_guards(self):
        source = (ROOT / 'start.ps1').read_text()
        self.assertIn('Local\\VidForgePCSiglipStarter', source)
        self.assertIn('$MaintenanceStart', source)
        self.assertIn('siglip-maintenance.json', source)
        self.assertIn('$InitialConfigPath', source)

    def test_activation_guard_refuses_busy_reused_and_unrelated_processes(self):
        file = ROOT.parent.parent / 'vf-custom' / 'helpers' / 'activate_siglip_max25.py'
        helper_spec = importlib.util.spec_from_file_location('activation', file)
        helper = importlib.util.module_from_spec(helper_spec)
        helper_spec.loader.exec_module(helper)
        expected = dict(Name='python.exe', ProcessId=1234, Started='fixture-start',
                        CommandLine=f'python.exe "{ROOT / "service.py"}"')
        self.assertTrue(helper.safe_to_stop(expected, expected, 0, True))
        self.assertFalse(helper.safe_to_stop(expected, expected, 2, True))
        self.assertFalse(helper.safe_to_stop(expected, expected, 0, False))
        self.assertFalse(helper.safe_to_stop({**expected, 'Started': 'reused'}, expected, 0, True))
        self.assertFalse(helper.safe_to_stop({**expected, 'ProcessId': 999}, expected, 0, True))
        self.assertFalse(helper.safe_to_stop({**expected, 'Name': 'ffmpeg.exe'}, expected, 0, True))
        self.assertFalse(helper.safe_to_stop({**expected, 'CommandLine': 'python.exe repair_batch.py'}, expected, 0, True))

    def test_hidden_launcher_does_not_capture_pipes_inherited_by_persistent_services(self):
        file = ROOT.parent.parent / 'vf-custom' / 'helpers' / 'activate_siglip_max25.py'
        helper_spec = importlib.util.spec_from_file_location('activation_launch', file)
        helper = importlib.util.module_from_spec(helper_spec)
        helper_spec.loader.exec_module(helper)
        self.assertTrue(callable(getattr(helper, 'launch_hidden', None)))
        calls = []
        class Process:
            def wait(self, timeout):
                return 0
        def launch(command, **kwargs):
            calls.append(kwargs)
            return Process()
        with tempfile.TemporaryDirectory() as directory, patch.object(helper.subprocess, 'Popen', side_effect=launch):
            self.assertEqual(helper.launch_hidden(['fixture-only'], Path(directory) / 'startup.log', 5), 0)
        self.assertEqual(calls[0]['stdin'], helper.subprocess.DEVNULL)
        self.assertNotEqual(calls[0]['stdout'], helper.subprocess.PIPE)
        self.assertEqual(calls[0]['stderr'], helper.subprocess.STDOUT)

    def test_readiness_wait_tolerates_launcher_exit_before_listener_without_killing(self):
        file = ROOT.parent.parent / 'vf-custom' / 'helpers' / 'activate_siglip_max25.py'
        helper_spec = importlib.util.spec_from_file_location('activation_wait', file)
        helper = importlib.util.module_from_spec(helper_spec)
        helper_spec.loader.exec_module(helper)
        self.assertTrue(callable(getattr(helper, 'wait_ready', None)))
        limits = dict(ffmpegMaxFileMb=64, ffmpegMaxTotalMb=96, sceneMaxFileMb=400, siglipMaxImageMb=20)
        responses = [ConnectionRefusedError(), (123, 200, {'ready': False}),
                     (123, 200, {'ready': True, 'transferLimits': limits})]
        with patch.object(helper, 'request', side_effect=responses), patch.object(helper.time, 'sleep'):
            self.assertEqual(helper.wait_ready('test-only', 18194, require_transfer=True)[0], 123)

    def test_starter_timeout_still_waits_for_persistent_worker_before_clearing_gate(self):
        file = ROOT.parent.parent / 'vf-custom' / 'helpers' / 'activate_siglip_max25.py'
        helper_spec = importlib.util.spec_from_file_location('activation_start_wait', file)
        helper = importlib.util.module_from_spec(helper_spec)
        helper_spec.loader.exec_module(helper)
        self.assertTrue(callable(getattr(helper, 'start_then_ready', None)))
        with patch.object(helper, 'launch_hidden', side_effect=helper.subprocess.TimeoutExpired('fixture', 1)), \
             patch.object(helper, 'wait_ready', return_value=(123, 200, {'ready': True})) as wait:
            self.assertEqual(helper.start_then_ready(['fixture'], Path('unused.log'), 'test-only', 18191, 1, True)[0], 123)
            wait.assert_called_once_with('test-only', 18191, require_transfer=True)

    def test_duplicate_target_request_never_sends_config_to_wrong_listener(self):
        file = ROOT.parent.parent / 'vf-custom' / 'helpers' / 'activate_siglip_max25.py'
        helper_spec = importlib.util.spec_from_file_location('activation_exact_owner', file)
        helper = importlib.util.module_from_spec(helper_spec)
        helper_spec.loader.exec_module(helper)
        self.assertIn('expected_owner', __import__('inspect').signature(helper.request).parameters)
        connection = unittest.mock.MagicMock()
        connection.sock.getsockname.return_value = ('127.0.0.1', 54321)
        with patch.object(helper.http.client, 'HTTPConnection', return_value=connection), \
             patch.object(helper, 'powershell', return_value='999'):
            self.assertEqual(helper.request('PUT', '/config', 'test-only', {}, port=18191, expected_owner=123), (999, 0, {}))
        connection.request.assert_not_called()
        connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
