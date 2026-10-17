import ast
import importlib.util
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / 'helpers' / 'pc_boost_bandwidth_bridge.py'
WORKER = ROOT.parent / 'vf-speed-20261002' / 'ffmpeg' / 'pc_ffmpeg_worker.py'


class BandwidthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = None
        if BRIDGE.exists():
            spec = importlib.util.spec_from_file_location('bridge', BRIDGE)
            cls.bridge = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.bridge)

    def setUp(self):
        if self.bridge is None and self._testMethodName != 'test_bridge_exists':
            self.skipTest('implementation not yet present')

    def test_bridge_exists(self):
        self.assertTrue(BRIDGE.exists(), 'dedicated bridge implementation is missing')

    def actual_limiter(self, config_file):
        # Execute the exact existing class, not a replacement limiter or TCP counter.
        tree = ast.parse(WORKER.read_text(encoding='utf-8'))
        node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'RateLimiter')
        namespace = {'json': json, 'time': time, 'threading': threading, 'NET_LIMITS_FILE': config_file}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(WORKER), 'exec'), namespace)
        return namespace['RateLimiter']

    def test_atomic_apply_readback_reaches_actual_directional_limiters(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'net-limits.json'
            path.write_text('{"downMbit":120,"upMbit":37,"unrelated":"keep"}')
            expected = {'downMbit': 80, 'upMbit': 25}
            self.assertEqual(self.bridge.apply_limits(path, expected), expected)
            self.assertEqual(json.loads(path.read_text())['unrelated'], 'keep')
            limiter = self.actual_limiter(path)
            down, up = limiter(120, 'downMbit'), limiter(43, 'upMbit')
            down.refresh()
            up.refresh()
            self.assertEqual(down.bytes_per_second, 10_000_000)
            self.assertEqual(up.bytes_per_second, 3_125_000)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_actual_limiter_shares_one_budget_across_calls_and_refreshes_at_five_seconds(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'net-limits.json'
            path.write_text('{"downMbit":120,"upMbit":37}')
            self.bridge.apply_limits(path, {'downMbit': 8, 'upMbit': 8})
            limiter = self.actual_limiter(path)
            with patch.object(time, 'monotonic', return_value=100), patch.object(time, 'sleep') as sleep:
                shared = limiter(120, 'downMbit')
                shared.take(1_000_000)
                shared.take(1_000_000)
                self.assertEqual(shared.next_free, 102)
                sleep.assert_called_once_with(1)
                self.bridge.apply_limits(path, {'downMbit': 16, 'upMbit': 8})
                shared.refresh()
                self.assertEqual(shared.bytes_per_second, 1_000_000)
            with patch.object(time, 'monotonic', return_value=106):
                shared.refresh()
                self.assertEqual(shared.bytes_per_second, 2_000_000)

    def test_zero_is_rejected_because_actual_worker_falls_back_not_uncaps(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'net-limits.json'
            path.write_text('{"downMbit":120,"upMbit":37}')
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                self.bridge.apply_limits(path, {'downMbit': 0, 'upMbit': 37})
            self.assertEqual(path.read_bytes(), before)
            path.write_text('{"downMbit":0,"upMbit":0}')
            down = self.actual_limiter(path)(120, 'downMbit')
            down.refresh()
            self.assertEqual(down.bytes_per_second, 15_000_000)

    def test_no_desired_setting_reads_existing_file_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'net-limits.json'
            path.write_text('{"downMbit":119.5,"upMbit":36.5}')
            before = path.stat().st_mtime_ns
            self.assertEqual(self.bridge.apply_limits(path, None), {'downMbit': 119.5, 'upMbit': 36.5})
            self.assertEqual(path.stat().st_mtime_ns, before)

    def test_invalid_settings_or_corrupt_local_state_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'net-limits.json'
            path.write_text('{"downMbit":120,"upMbit":37}')
            for rates in [{'downMbit': 1001, 'upMbit': 37}, {'downMbit': True, 'upMbit': 37},
                          {'downMbit': '120', 'upMbit': 37}, {'downMbit': 1.5, 'upMbit': 37},
                          {'downMbit': 120, 'upMbit': 37, 'token': 'not accepted'}]:
                with self.assertRaises(ValueError):
                    self.bridge.apply_limits(path, rates)
            path.write_text('{broken')
            with self.assertRaises(ValueError):
                self.bridge.apply_limits(path, {'downMbit': 80, 'upMbit': 25})
            self.assertEqual(path.read_text(), '{broken')

    def test_write_failure_keeps_original_and_never_acknowledges(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'net-limits.json'
            path.write_text('{"downMbit":120,"upMbit":37}')
            before = path.read_bytes()
            with patch.object(self.bridge.os, 'replace', side_effect=OSError('test only')):
                with self.assertRaises(OSError):
                    self.bridge.apply_limits(path, {'downMbit': 80, 'upMbit': 25})
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_poll_acks_only_matching_file_readback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'net-limits.json'
            path.write_text('{"downMbit":120,"upMbit":37}')
            calls = []
            def request(method, endpoint, body=None):
                calls.append((method, endpoint, body))
                return {'desired': {'downMbit': 80, 'upMbit': 25}, 'revision': 'abc'} if method == 'GET' else {}
            self.bridge.poll_once(path, request)
            self.assertEqual(calls[-1][2], {'revision': 'abc', 'observed': {'downMbit': 80, 'upMbit': 25}})
            calls.clear()
            with patch.object(self.bridge.os, 'replace', side_effect=OSError('test only')):
                with self.assertRaises(OSError):
                    def changed(method, endpoint, body=None):
                        calls.append((method, endpoint, body))
                        return {'desired': {'downMbit': 70, 'upMbit': 20}, 'revision': 'def'}
                    self.bridge.poll_once(path, changed)
            self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
