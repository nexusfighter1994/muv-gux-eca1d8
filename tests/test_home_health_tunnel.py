import errno
import importlib.util
import pathlib
import socket
import tempfile
import unittest
from unittest import mock


SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'home-health-tunnel' / 'remote.py'


class HealthTunnelTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('health_tunnel_remote', SOURCE)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name) / 'test.sock'

    def bind(self, live=False):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(str(self.path))
        if live:
            sock.listen(2)
            self.addCleanup(sock.close)
        else:
            sock.close()

    def test_missing_socket_is_safe(self):
        self.assertEqual(self.helper.prepare_socket(self.path), 'absent')

    def test_refused_stale_socket_is_removed(self):
        self.bind()
        self.assertEqual(self.helper.prepare_socket(self.path), 'removed-stale')
        self.assertFalse(self.path.exists())

    def test_live_socket_is_never_unlinked(self):
        self.bind(live=True)
        with self.assertRaisesRegex(RuntimeError, 'live'):
            self.helper.prepare_socket(self.path)
        self.assertTrue(self.path.exists())

    def test_regular_file_is_never_removed(self):
        self.path.write_text('keep')
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            self.helper.prepare_socket(self.path)
        self.assertEqual(self.path.read_text(), 'keep')

    def test_symlink_is_never_removed(self):
        target = pathlib.Path(self.temp.name) / 'target'
        target.write_text('keep')
        self.path.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            self.helper.prepare_socket(self.path)
        self.assertTrue(self.path.is_symlink())

    def test_timeout_is_not_treated_as_stale(self):
        self.bind()
        with mock.patch.object(self.helper, 'probe', side_effect=TimeoutError()):
            with self.assertRaises(TimeoutError):
                self.helper.prepare_socket(self.path)
        self.assertTrue(self.path.exists())

    def test_changed_inode_is_never_removed(self):
        self.bind()
        def replace(path):
            self.path.unlink()
            self.path.write_text('replacement')
            raise ConnectionRefusedError(errno.ECONNREFUSED, 'refused')
        with mock.patch.object(self.helper, 'probe', side_effect=replace):
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                self.helper.prepare_socket(self.path)
        self.assertEqual(self.path.read_text(), 'replacement')

    def test_verify_rejects_refused_socket(self):
        self.bind()
        with self.assertRaises(ConnectionRefusedError):
            self.helper.verify_socket(self.path)
        self.assertTrue(self.path.exists())

    def test_verify_live_socket_sets_only_expected_permissions(self):
        self.bind(live=True)
        with mock.patch.object(self.helper.os, 'chown') as owner:
            self.helper.verify_socket(self.path)
        owner.assert_called_once_with(self.path, 10001, 10001, follow_symlinks=False)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o660)


if __name__ == '__main__':
    unittest.main()
