import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPERS = Path(__file__).resolve().parents[1] / 'helpers'
sys.path.insert(0, str(HELPERS))
REVISION = 'fd7e1234-1111-4111-8111-123456789abc'


class DesiredMirrorTests(unittest.TestCase):
    def mirror(self):
        file = HELPERS / 'pc_boost_bandwidth_mirror.py'
        self.assertTrue(file.is_file(), 'GET-only desired mirror does not exist yet')
        spec = importlib.util.spec_from_file_location('desired_mirror', file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_only_get_preserves_revision_atomically_merges19070_and_keeps_unknown_fields(self):
        mirror = self.mirror()
        calls = []
        def request(*args):
            calls.append(args)
            return {'desired': {'downMbit': 190, 'upMbit': 70}, 'revision': REVISION}
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'net-limits.json'
            file.write_text(json.dumps({'downMbit': 120, 'upMbit': 37, 'preserved': {'tag': 'fixture'}}))
            result = mirror.poll_once(file, request)
            self.assertEqual(calls, [('GET', '/api/pc-boost/bandwidth/bridge')])
            self.assertEqual(result['revision'], REVISION)
            self.assertEqual(result['observed'], {'downMbit': 190, 'upMbit': 70})
            self.assertEqual(result['scope'], 'local_ffmpeg_file_only')
            self.assertEqual(json.loads(file.read_text())['preserved'], {'tag': 'fixture'})
            self.assertFalse(list(Path(directory).glob('.net-limits-*.tmp')))
            before = file.read_bytes()
            import pc_boost_bandwidth_bridge
            with patch.object(pc_boost_bandwidth_bridge.os, 'replace', side_effect=AssertionError('Same rates must not rewrite')):
                mirror.poll_once(file, request)
            self.assertEqual(file.read_bytes(), before)

    def test_unmanaged_null_is_no_change_even_when_file_absent(self):
        mirror = self.mirror()
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'missing.json'
            with patch.object(mirror, 'apply_limits', side_effect=AssertionError('Must not write or apply')):
                result = mirror.poll_once(file, lambda *args: {'desired': None, 'revision': None})
            self.assertFalse(result['managed'])
            self.assertFalse(file.exists())

    def test_bad_remote_state_or_write_failure_does_not_change_existing_rates(self):
        mirror = self.mirror()
        valid = {'desired': {'downMbit': 190, 'upMbit': 70}, 'revision': REVISION}
        invalid = [{**valid, 'revision': 'bad'}, {**valid, 'unknown': 1},
                   {**valid, 'url': 'https://untrusted.invalid/collect'},
                   {**valid, 'desired': {'downMbit': 190, 'upMbit': 70, 'command': 'never execute'}},
                   {**valid, 'desired': {'downMbit': 0, 'upMbit': 70}},
                   {**valid, 'desired': {'downMbit': True, 'upMbit': 70}},
                   {**valid, 'desired': {'downMbit': 190.5, 'upMbit': 70}},
                   {**valid, 'desired': {'downMbit': 190, 'upMbit': 1001}}]
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'net-limits.json'
            file.write_text('{"downMbit":120,"upMbit":37,"unchanged":1}')
            before = file.read_bytes()
            for value in invalid:
                with self.assertRaises(ValueError):
                    mirror.poll_once(file, lambda *args: value)
                self.assertEqual(file.read_bytes(), before)
            import pc_boost_bandwidth_bridge
            with patch.object(pc_boost_bandwidth_bridge.os, 'replace', side_effect=OSError('fixture failure')), self.assertRaises(OSError):
                mirror.poll_once(file, lambda *args: valid)
            self.assertEqual(file.read_bytes(), before)

    def test_private_transport_is_fixed_https_bounded_and_redirects_disabled(self):
        mirror = self.mirror()
        import pc_boost_bandwidth_bridge as transport
        requests = []
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps({'desired': None, 'revision': None}).encode()
        opener = unittest.mock.MagicMock()
        def opened(request, timeout):
            requests.append((request, timeout))
            return response
        opener.open.side_effect = opened
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / 'test-token.txt'
            token.write_text('test-only-token')
            with patch.object(transport.urllib.request, 'build_opener', return_value=opener) as build:
                request = mirror.remote_request(token)
                mirror.poll_once(Path(directory) / 'absent.json', request)
            self.assertIsInstance(build.call_args.args[1], transport.NoRedirect)
            self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertEqual(len(requests), 1)
        req, timeout = requests[0]
        self.assertEqual(req.full_url, 'https://vidforge.example/api/pc-boost/bandwidth/bridge')
        self.assertEqual(req.get_method(), 'GET')
        self.assertEqual(timeout, 6)
        response.read.assert_called_once_with(65537)
        self.assertIsNone(transport.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://untrusted.invalid/'))

    def test_local_single_instance_mutex_and_hidden_nextlogin_launcher(self):
        mirror = self.mirror()
        import uuid
        name = 'Local\\TestOnlyDesiredMirror-' + str(uuid.uuid4())
        with mirror.single_instance(name) as first:
            self.assertTrue(first)
            # Different thread: Windows mutexes are recursive within one owning thread.
            import threading
            values = []
            def attempt():
                with mirror.single_instance(name) as acquired:
                    values.append(acquired)
            thread = threading.Thread(target=attempt)
            thread.start()
            thread.join(timeout=5)
            self.assertEqual(values, [False])
        home = HELPERS.parent.parent / 'vf-speed-20261002'
        watchdog = (home / 'start-home-boost.ps1').read_text()
        self.assertIn('pc_boost_bandwidth_mirror.py', watchdog)
        self.assertIn('-WindowStyle Hidden', watchdog)
        self.assertIn('bandwidth-mirror.stdout.log', watchdog)
        self.assertNotIn('pc_boost_bandwidth_bridge.py', watchdog)


if __name__ == '__main__':
    unittest.main()
