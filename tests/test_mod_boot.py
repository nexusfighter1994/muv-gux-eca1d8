"""Generation bootstrap tests use real SQLite and temporary files, never application imports."""
import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

FILE = Path(__file__).resolve().parents[1] / 'fflow/mod_boot.py'


class BootSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(FILE.is_file(), 'Generation bootstrap helper is missing')
        spec = importlib.util.spec_from_file_location('fixture_mod_boot', FILE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix='vf-mod-boot-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / 'vidforge.db'
        self.runtime = self.root / 'runtime/active.json'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)')

    def save(self, enabled):
        state = {'version': 1, 'revision': str(uuid.uuid4()), 'changedAt': '2026-10-15T06:00:00.000Z',
                 'mods': {'homeQueue': enabled, 'homeFfmpeg': enabled, 'slotCleanup': enabled}}
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('INSERT OR REPLACE INTO app_settings VALUES (?, ?)', ('vf_mods', json.dumps(state)))
        return state

    def load(self, generation):
        return self.module.load_snapshot(database=self.database, runtime=self.runtime, generation=generation)

    def test_first_python_consumer_replaces_old_generation_from_desired_before_processing(self):
        saved = self.save(False)
        self.runtime.parent.mkdir()
        self.runtime.write_text(json.dumps({'version': 1, 'generation': 'old', 'mods': {'homeQueue': True}}))
        state = self.load('current')
        self.assertFalse(state['mods']['homeQueue'])
        self.assertFalse(state['mods']['slotCleanup'])
        self.assertEqual(state['revision'], saved['revision'])
        self.assertEqual(state['generation'], 'current')
        self.assertEqual(json.loads(self.runtime.read_text()), state)

    def test_late_children_keep_same_snapshot_after_desired_patch_until_generation_changes(self):
        self.save(False)
        before = self.load('first')
        active_bytes = self.runtime.read_bytes()
        self.save(True)
        self.assertEqual(self.load('first'), before)
        self.assertEqual(self.runtime.read_bytes(), active_bytes)
        self.assertTrue(self.load('second')['mods']['homeQueue'])

    def test_no_saved_policy_keeps_all_30_defaults_true_without_writing_database(self):
        state = self.load('fresh')
        self.assertEqual(len(state['mods']), 30)
        self.assertTrue(state['mods']['thumbnailIdentity'])
        self.assertTrue(all(state['mods'].values()))
        self.assertIsNone(state['revision'])
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM app_settings').fetchone()[0], 0)

    def test_corrupt_current_generation_and_corrupt_desired_fail_closed(self):
        self.save(False)
        self.load('current')
        broken = {'version': 1, 'generation': 'current', 'mods': {'homeQueue': 'false'}}
        self.runtime.write_text(json.dumps(broken))
        with self.assertRaises(ValueError):
            self.load('current')
        self.assertEqual(json.loads(self.runtime.read_text()), broken)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE app_settings SET value_json = '{broken'")
        with self.assertRaises(ValueError):
            self.load('next')

    def test_generation_identity_uses_host_boot_and_container_pid1_start_not_worker_pid(self):
        fields = ['S'] + ['0'] * 18 + ['12345'] + ['0'] * 3
        def content(file, *args, **kwargs):
            return 'boot-id\n' if str(file).endswith('boot_id') else '1 (command with spaces) ' + ' '.join(fields)
        with patch.object(Path, 'read_text', content):
            self.assertEqual(self.module.generation_id(), 'boot-id:12345')

    def test_engine_data_dir_cannot_select_a_different_policy_database(self):
        self.save(False)
        with patch.dict(self.module.os.environ, {'DATA_DIR':str(self.root/'engines/fflow'),
                'VF_MODS_DATABASE':str(self.database)}):
            state=self.module.load_snapshot(runtime=self.runtime,generation='engine-first')
        self.assertFalse(state['mods']['homeQueue'])


if __name__ == '__main__':
    unittest.main()
