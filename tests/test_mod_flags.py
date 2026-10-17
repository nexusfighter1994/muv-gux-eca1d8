import importlib.util
from io import BytesIO
import json
from pathlib import Path
import unittest
from unittest.mock import patch


FILE = Path(__file__).resolve().parents[1] / 'fflow' / 'mod_flags.py'
OPTIONAL = ('homeFfmpeg', 'homeScenes', 'homeQueue')
SAFETY = ('slotCleanup', 'fxRetention', 'fxSentinel')


class ModFlagTests(unittest.TestCase):
    def load(self, raw=None, error=None):
        self.assertTrue(FILE.is_file(), 'Boot snapshot mod_flags.py is missing')
        spec = importlib.util.spec_from_file_location('fixture_mod_flags', FILE)
        module = importlib.util.module_from_spec(spec)
        with patch.object(Path, 'open', side_effect=error,
                          return_value=BytesIO(raw or b'')) as reader:
            spec.loader.exec_module(module)
        self.assertEqual(reader.call_count, 1)
        return module

    def test_absent_snapshot_preserves_all_existing_behavior(self):
        flags = self.load(error=FileNotFoundError())
        for key in OPTIONAL + SAFETY + ('unrelatedMod',):
            self.assertIs(flags.mod_enabled(key), True)

    def test_explicit_flags_are_independent_and_missing_keys_default_true(self):
        for disabled in OPTIONAL + SAFETY:
            with self.subTest(disabled=disabled):
                flags = self.load(json.dumps({'version': 1, 'mods': {disabled: False},
                                             'revision': 'fixture'}).encode())
                for key in OPTIONAL + SAFETY:
                    self.assertIs(flags.mod_enabled(key), key != disabled)

    def test_flags_are_snapshotted_at_import_not_read_on_each_admission(self):
        flags = self.load(b'{"version":1,"mods":{"homeFfmpeg":false}}')
        with patch.object(Path, 'open', side_effect=AssertionError('Must not reload')):
            for _ in range(3):
                self.assertIs(flags.mod_enabled('homeFfmpeg'), False)
                self.assertIs(flags.mod_enabled('slotCleanup'), True)

    def test_new_process_snapshot_can_pick_up_new_active_revision(self):
        before = self.load(b'{"version":1,"mods":{"homeQueue":true}}')
        after = self.load(b'{"version":1,"mods":{"homeQueue":false}}')
        self.assertTrue(before.mod_enabled('homeQueue'))
        self.assertFalse(after.mod_enabled('homeQueue'))

    def test_malformed_envelope_fails_to_native_with_safety_guards_retained(self):
        values = (b'', b'{broken', b'[]', b'null', b'{}',
                  b'{"version":true,"mods":{}}', b'{"version":1.0,"mods":{}}',
                  b'{"version":2,"mods":{}}', b'{"version":1,"mods":[]}',
                  b'{"version":1,"mods":{},"version":2}',
                  b'{"version":1,"mods":{"homeQueue":true,"homeQueue":false}}',
                  b'{"version":1,"mods":{},"extra":NaN}', b'\xff', b' ' * 65537)
        for raw in values:
            with self.subTest(raw=raw[:80]):
                self.assert_safe(self.load(raw))

    def test_flags_require_actual_booleans_including_unrecognized_flags(self):
        for value in (None, 0, 1, 'false', [], {}):
            for key in ('homeFfmpeg', 'slotCleanup', 'futureMod'):
                with self.subTest(key=key, value=value):
                    self.assert_safe(self.load(json.dumps(
                        {'version': 1, 'mods': {key: value}}).encode()))

    def test_unreadable_snapshot_is_not_treated_as_absent(self):
        for error in (PermissionError(), OSError()):
            self.assert_safe(self.load(error=error))

    def assert_safe(self, flags):
        for key in OPTIONAL:
            self.assertIs(flags.mod_enabled(key), False)
        for key in SAFETY:
            self.assertIs(flags.mod_enabled(key), True)


if __name__ == '__main__':
    unittest.main()
