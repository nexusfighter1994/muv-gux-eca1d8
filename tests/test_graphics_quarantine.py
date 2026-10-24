import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'home-graphics-worker' / 'motion-offload'
sys.path.insert(0, str(ROOT))
import transport


class Process:
    def __init__(self, stuck=False):
        self.pid = 987654
        self.returncode = None if stuck else 0
        self.stuck = stuck
        self.disposed = False

    def poll(self):
        return self.returncode

    def communicate(self, *args, **kwargs):
        if self.stuck:
            raise subprocess.TimeoutExpired('fixture', 1)
        return b'{}', b''

    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired('fixture', timeout)
        return self.returncode

    def terminate_tree(self):
        if self.stuck:
            raise OSError('fixture termination not confirmed')

    def tree_exited(self):
        return self.returncode is not None

    def dispose(self):
        self.disposed = True


class QuarantineTests(unittest.TestCase):
    def service(self):
        self.used = 0
        self.releases = 0

        def acquire():
            self.used += 1
            def release():
                self.used -= 1
                self.releases += 1
            return release
        service = transport.MotionService(['fixture'], 'fixture', acquire)
        self.services = getattr(self, 'services', []) + [service]
        return service

    def tearDown(self):
        for service in getattr(self, 'services', []):
            for record in list(service.records.values()):
                process = record['process']
                if process:
                    process.returncode, process.stuck = 1, False
                    process.tree_exited = lambda: True
            service.reap_quarantined()

    def invoke(self, service, process, identifier='a' * 32):
        with patch.object(transport, 'TreeProcess', return_value=process, create=True), \
                patch.object(transport.subprocess, 'Popen', return_value=process), \
                patch.object(transport.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)):
            return service.render({'id': identifier, 'contract': 'fixture', 'timeoutMs': 1})

    def hold(self, service):
        stuck = Process(stuck=True)
        with self.assertRaises(RuntimeError):
            self.invoke(service, stuck)
        return stuck

    def test_failed_termination_does_not_block_unrelated_jobs(self):
        service = self.service()
        self.hold(service)
        self.assertEqual(self.invoke(service, Process(), 'b' * 32), {})
        self.assertEqual(self.used, 1)

    def test_late_exit_releases_only_that_jobs_lease_once(self):
        service = self.service()
        stuck = self.hold(service)
        self.assertTrue(hasattr(service, 'reap_quarantined'), 'missing late-exit recovery')
        service.reap_quarantined()
        self.assertEqual(self.used, 1)
        stuck.returncode = 1
        stuck.stuck = False
        service.reap_quarantined()
        service.reap_quarantined()
        self.assertEqual((self.used, self.releases), (0, 1))
        self.assertFalse(service.slot.locked())
        self.assertTrue(stuck.disposed)

    def test_unknown_cancel_is_not_blocked_by_another_quarantine(self):
        service = self.service()
        self.hold(service)
        self.assertEqual(service.cancel('c' * 32), {'terminated': True})

    def test_reaper_does_not_release_a_live_tree(self):
        service = self.service()
        stuck = self.hold(service)
        self.assertTrue(hasattr(service, 'reap_quarantined'), 'missing late-exit recovery')
        stuck.returncode = 0
        stuck.tree_exited = lambda: False
        service.reap_quarantined()
        self.assertEqual(self.used, 1)

    def test_success_and_cleanup_error_release_budget(self):
        service = self.service()
        directory = types.SimpleNamespace(name=str(ROOT), cleanup=lambda: (_ for _ in ()).throw(OSError('fixture')))
        with patch.object(transport.tempfile, 'TemporaryDirectory', return_value=directory):
            self.assertEqual(self.invoke(service, Process()), {})
        self.assertEqual((self.used, self.releases), (0, 1))

    def test_cancelled_id_cannot_be_reused(self):
        service = self.service()
        service.cancel('a' * 32)
        with self.assertRaisesRegex(RuntimeError, 'cancelled|replay'):
            self.invoke(service, Process())
        self.assertEqual(self.used, 0)

    def test_many_completed_jobs_do_not_trip_global_replay_limit(self):
        service = self.service()
        directory = types.SimpleNamespace(name=str(ROOT), cleanup=lambda: None)
        with patch.object(transport.tempfile, 'TemporaryDirectory', return_value=directory), \
                patch.object(transport, 'TreeProcess', side_effect=lambda *a, **k: Process()):
            for number in range(4200):
                self.assertEqual(service.render({'id': f'{number:032x}', 'contract': 'fixture'}), {})
        self.assertEqual(self.used, 0)
        self.assertLessEqual(len(service.completed), 4096)
        self.assertFalse(service.cancelled)

    def test_recent_completed_id_cannot_be_reused(self):
        service = self.service()
        self.invoke(service, Process())
        with self.assertRaisesRegex(RuntimeError, 'cancelled|replay'):
            self.invoke(service, Process())
        self.assertEqual((self.used, self.releases), (0, 1))

    def test_background_recovery_needs_no_new_request(self):
        service = self.service()
        stuck = self.hold(service)
        stuck.returncode, stuck.stuck = 1, False
        deadline = time.monotonic() + 3
        while self.used and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertEqual(self.used, 0)
        self.assertEqual(service.health()['recoveredJobs'], 1)

    def test_blocked_termination_does_not_hold_service_lock(self):
        service = self.service()
        stuck = self.hold(service)
        entered, finish = threading.Event(), threading.Event()
        def terminate():
            entered.set()
            finish.wait(2)
            raise OSError('fixture')
        stuck.terminate_tree = terminate
        def cancel():
            try:
                service.cancel('a' * 32)
            except RuntimeError:
                pass
        thread = threading.Thread(target=cancel)
        thread.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertTrue(service.lock.acquire(timeout=.1), 'termination must not block other requests')
            service.lock.release()
            self.assertEqual(self.invoke(service, Process(), 'd' * 32), {})
        finally:
            finish.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())

    def test_duplicate_cancel_cannot_double_release(self):
        service = self.service()
        stuck = self.hold(service)
        stuck.returncode, stuck.stuck = 0, False
        threads = [threading.Thread(target=service.reap_quarantined) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(2)
        self.assertEqual((self.used, self.releases), (0, 1))
        service.cancel('a' * 32)
        self.assertEqual(self.releases, 1)

    def test_real_deadline_is_bounded_and_releases_budget(self):
        service = self.service()
        service.command = [sys.executable, '-c', 'import sys,time;sys.stdin.read();time.sleep(60)']
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'deadline'):
            service.render({'id': 'e' * 32, 'contract': 'fixture', 'timeoutMs': 1})
        deadline = time.monotonic() + 3
        while self.used and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertLess(time.monotonic() - started, 12)
        self.assertEqual(self.used, 0)


if __name__ == '__main__':
    unittest.main()
