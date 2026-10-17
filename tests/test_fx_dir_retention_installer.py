import asyncio
import ast
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import textwrap
import time
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import patch


# Exact method snapshots extracted read-only from image20 on 2026-10-14.
LOCAL_METHOD = '''    async def cleanup_old_files(self, max_age_hours: Optional[int] = None) -> Tuple[int, int]:
        """Remove temp files older than retention period."""
        if max_age_hours is None:
            max_age_hours = settings.temp_retention_hours

        temp_dir = Path(settings.temp_dir)
        if not temp_dir.exists():
            return (0, 0)

        cutoff_time = time.time() - (max_age_hours * 3600)

        async with self._cleanup_lock:
            files_deleted = 0
            bytes_freed = 0

            for item in temp_dir.rglob("*"):
                if not item.is_file():
                    continue
                try:
                    if temp_file_last_touched(item.stat()) < cutoff_time:
                        size = item.stat().st_size
                        item.unlink()
                        files_deleted += 1
                        bytes_freed += size
                except Exception as e:
                    logger.warning(f"Failed to delete old file {item}: {e}")

            for item in list(temp_dir.rglob("*")):
                if item.is_dir() and not any(item.iterdir()):
                    try:
                        item.rmdir()
                    except Exception:
                        pass

            if files_deleted > 0:
                logger.info(
                    f"Cleaned up old files: count={files_deleted}, "
                    f"size={bytes_freed:,} bytes, max_age={max_age_hours}h"
                )

            return (files_deleted, bytes_freed)
'''

MINIO_METHOD = '''    async def cleanup_old_files(self, max_age_hours: Optional[int] = None) -> Tuple[int, int]:
        """
        Remove temp files older than retention period.

        This is a safety mechanism to prevent disk filling up if job cleanup
        fails. Runs periodically as a background task.

        Why age-based: Recent files might belong to active jobs. Older files
        are likely from failed jobs that didn't clean up properly.

        Args:
            max_age_hours: Maximum age in hours (uses config if not provided)

        Returns:
            Tuple of (number of files deleted, bytes freed)
        """
        if max_age_hours is None:
            max_age_hours = settings.temp_retention_hours

        temp_dir = Path(settings.temp_dir)

        if not temp_dir.exists():
            return (0, 0)

        import time
        cutoff_time = time.time() - (max_age_hours * 3600)

        async with self._cleanup_lock:
            files_deleted = 0
            bytes_freed = 0

            for item in temp_dir.rglob("*"):
                if not item.is_file():
                    continue

                try:
                    if temp_file_last_touched(item.stat()) < cutoff_time:
                        size = item.stat().st_size
                        item.unlink()
                        files_deleted += 1
                        bytes_freed += size
                except Exception as e:
                    logger.warning(f"Failed to delete old file {item}: {e}")

            # Remove empty directories
            for item in list(temp_dir.rglob("*")):
                if item.is_dir() and not any(item.iterdir()):
                    try:
                        item.rmdir()
                    except Exception:
                        pass

            if files_deleted > 0:
                logger.info(
                    f"Cleaned up old files: count={files_deleted}, "
                    f"size={bytes_freed:,} bytes, max_age={max_age_hours}h"
                )

            return (files_deleted, bytes_freed)
'''

METHODS = {'local': LOCAL_METHOD, 'minio': MINIO_METHOD}
CLASSES = {'local': 'LocalStorage', 'minio': 'MinioClient'}
LEGACY_PATCH = '''            for item in list(temp_dir.rglob("*")):
                if item.is_dir() and not any(item.iterdir()):
                    try:
                        # vf-custom:fx-dir-retention-v1
                        if temp_file_last_touched(item.stat()) < cutoff_time:
                            item.rmdir()
                    except Exception:
                        pass
'''
installer_path = Path(__file__).resolve().parent.parent / 'fx-dir-retention-install.py'
installer = None
if installer_path.exists():
    spec = importlib.util.spec_from_file_location('fx_dir_retention_installer', installer_path)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)


def native_source(backend):
    return '# unrelated module code\nclass ' + CLASSES[backend] + ':\n' + METHODS[backend] + '\nUNCHANGED = 14\n'


def patched_source(backend):
    source = native_source(backend)
    return installer.patch_source(source, backend) if installer else source


async def run_method(source, directory, now, hours=None, enabled=True):
    tree = ast.parse(source)
    method = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == 'cleanup_old_files')
    method = ast.parse(textwrap.dedent('\n'.join(source.splitlines()[method.lineno - 1:method.end_lineno]))).body[0]
    namespace = {'Optional': __import__('typing').Optional, 'Tuple': __import__('typing').Tuple,
                 'Path': Path, 'time': time, 'settings': SimpleNamespace(temp_dir=str(directory), temp_retention_hours=12),
                 'temp_file_last_touched': lambda s: max(s.st_mtime, s.st_ctime),
                 'logger': SimpleNamespace(info=lambda *a: None, warning=lambda *a: None)}
    exec(compile(ast.Module(body=[method], type_ignores=[]), '<extracted-native-cleanup>', 'exec'), namespace)
    flags = ModuleType('src.core.mod_flags')
    flags.mod_enabled = lambda key: enabled if key == 'fxRetention' else True
    modules = {'src': ModuleType('src'), 'src.core': ModuleType('src.core'), 'src.core.mod_flags': flags}
    with patch('time.time', return_value=now), patch.dict(sys.modules, modules):
        return await namespace['cleanup_old_files'](SimpleNamespace(_cleanup_lock=asyncio.Lock()), hours)


class NativeCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_retention_keeps_expired_empty_dirs_but_runs_native_file_cleanup(self):
        for backend in METHODS:
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                expired = root / 'expired-empty'; expired.mkdir()
                old_file = root / 'expired.raw'; old_file.write_bytes(b'12345')
                active = root / 'fx-out-abcdefgh'; active.mkdir()
                marker = active / '.vf-fx-active'; marker.write_bytes(b'')
                now = time.time() + 24 * 3600
                os.utime(marker, (now, now))
                before = marker.stat()
                result = await run_method(patched_source(backend), root, now, enabled=False)
                self.assertEqual(result, (1, 5))
                self.assertFalse(old_file.exists())
                self.assertTrue(expired.is_dir(), 'disabled directory cleanup still removed a directory')
                self.assertEqual(marker.read_bytes(), b'')
                self.assertEqual(marker.stat().st_mtime_ns, before.st_mtime_ns)

    async def test_fresh_active_fx_directory_survives_until_encoder_opens_output(self):
        for backend in METHODS:
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); active = root / 'fx-out-active'; active.mkdir()
                now = time.time() + 24 * 3600
                os.utime(active, (now, now))
                self.assertEqual(await run_method(patched_source(backend), root, now), (0, 0))
                self.assertTrue(active.is_dir(), 'native janitor deleted the active empty FX directory')
                (active / 'windows.mp4').write_bytes(b'synthetic encoder placeholder')

    async def test_expired_empty_directory_is_still_deleted(self):
        for backend in METHODS:
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); expired = root / 'fx-out-expired'; expired.mkdir()
                await run_method(patched_source(backend), root, time.time() + 24 * 3600)
                self.assertFalse(expired.exists())

    async def test_old_file_cleanup_and_recent_files_are_unchanged(self):
        for backend in METHODS:
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); old = root / 'expired.raw'; old.write_bytes(b'12345')
                recent = root / 'recent.raw'; recent.write_bytes(b'keep')
                now = time.time() + 24 * 3600; os.utime(recent, (now, now))
                result = await run_method(patched_source(backend), root, now)
                self.assertEqual(result, (1, 5)); self.assertFalse(old.exists()); self.assertTrue(recent.exists())

    async def test_exact_cutoff_and_explicit_ttl_override_remain_strict(self):
        for backend in METHODS:
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); boundary = root / 'boundary'; boundary.mkdir()
                now = time.time() + 24 * 3600
                os.utime(boundary, (now - 3600, now - 3600))
                await run_method(patched_source(backend), root, now, 1)
                self.assertTrue(boundary.exists(), 'exact cutoff must not expire')
                await run_method(patched_source(backend), root, now + 1, 1)
                self.assertFalse(boundary.exists())

    async def test_directory_scan_atime_does_not_change_native_expiry_age(self):
        for backend in METHODS:
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); expired = root / 'expired'; expired.mkdir()
                now = time.time() + 24 * 3600
                os.utime(expired, (1, 1))
                before = expired.stat(); list(expired.iterdir()); after = expired.stat()
                self.assertEqual(max(before.st_mtime, before.st_ctime), max(after.st_mtime, after.st_ctime))
                await run_method(patched_source(backend), root, now)
                self.assertFalse(expired.exists())


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(installer, 'local installer not implemented')

    def test_actual_method_fingerprints_and_idempotence(self):
        expected = {'local': '629a1e319f94ccea16f1812f73359c8797f4a61a03c2b0d5dab3006ced0a791e',
                    'minio': '0cf7148a1a5b8e03f4fd294ae1c94e531beafa29f745e0c5691511b29a4bb7b8'}
        for backend, original in METHODS.items():
            self.assertEqual(hashlib.sha256(original.encode()).hexdigest(), expected[backend])
            source = native_source(backend); result = installer.patch_source(source, backend)
            self.assertNotEqual(source, result)
            self.assertEqual(installer.patch_source(result, backend), result)
            self.assertEqual(result.count(installer.MARKER), 1)
            self.assertEqual(result.count('temp_file_last_touched(item.stat()) < cutoff_time'), 2)
            self.assertTrue(result.endswith('\nUNCHANGED = 14\n'))

    def test_legacy_patch_upgrades_to_same_boot_gated_source(self):
        for backend in METHODS:
            source = native_source(backend)
            previous = source.replace(installer.OLD, LEGACY_PATCH)
            upgraded = installer.patch_source(previous, backend)
            self.assertIn("_vf_mod_enabled('fxRetention')", upgraded)
            self.assertEqual(upgraded, installer.patch_source(source, backend))
            self.assertEqual(installer.patch_source(upgraded, backend), upgraded)
            with self.assertRaises(RuntimeError):
                installer.patch_source(previous.replace('item.rmdir()', 'item.unlink()'), backend)

    def test_new_gate_tampering_and_mixed_markers_fail_closed(self):
        for backend in METHODS:
            result = installer.patch_source(native_source(backend), backend)
            self.assertIn("_vf_mod_enabled('fxRetention')", result)
            for bad in (result.replace("_vf_mod_enabled('fxRetention')", 'True'),
                        result + '# vf-custom:fx-dir-retention-v1\n'):
                with self.assertRaises(RuntimeError):
                    installer.patch_source(bad, backend)

    def test_crlf_and_unterminated_native_method_replay_remain_idempotent(self):
        for backend in METHODS:
            source = ('class ' + CLASSES[backend] + ':\n' + METHODS[backend]).rstrip('\n')
            source = source.replace('\n', '\r\n')
            result = installer.patch_source(source, backend)
            self.assertFalse(result.endswith('\n'))
            self.assertNotIn('\n', result.replace('\r\n', ''))
            self.assertEqual(installer.patch_source(result, backend), result)

    def test_drift_duplicate_and_partial_marker_fail_closed(self):
        for backend in METHODS:
            source = native_source(backend)
            for bad in (source.replace('cutoff_time = time.time()', 'cutoff_time = altered_clock()'),
                        source + source, source.replace('item.rmdir()', installer.MARKER + '\n                        item.rmdir()')):
                with self.assertRaises((RuntimeError, SyntaxError)):
                    installer.patch_source(bad, backend)
            changed = installer.patch_source(source, backend).replace('item.rmdir()', 'item.unlink()')
            with self.assertRaises(RuntimeError): installer.patch_source(changed, backend)

    def test_both_backends_are_validated_before_any_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); directory = root / 'src' / 'storage'; directory.mkdir(parents=True)
            local = directory / 'local.py'; minio = directory / 'minio.py'
            local.write_text(native_source('local'), encoding='utf-8'); minio.write_text('upstream drift', encoding='utf-8')
            before = local.read_bytes()
            with self.assertRaises(RuntimeError): installer.install(root, apply=True)
            self.assertEqual(local.read_bytes(), before)

    def test_check_mode_install_and_second_install_are_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); directory = root / 'src' / 'storage'; directory.mkdir(parents=True)
            for backend in METHODS: (directory / (backend + '.py')).write_text(native_source(backend), encoding='utf-8')
            self.assertEqual(installer.install(root)['changed'], ['local', 'minio'])
            self.assertNotIn(installer.MARKER, (directory / 'local.py').read_text())
            self.assertEqual(installer.install(root, apply=True)['changed'], ['local', 'minio'])
            before = {b: (directory / (b + '.py')).read_bytes() for b in METHODS}
            self.assertEqual(installer.install(root, apply=True)['changed'], [])
            self.assertEqual(before, {b: (directory / (b + '.py')).read_bytes() for b in METHODS})


if __name__ == '__main__':
    unittest.main()
