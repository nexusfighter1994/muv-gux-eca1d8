import ast
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]
STORAGE=Path(os.environ.get('VF_FFLOW_STORAGE',str(ROOT/'fflow-storage')))

class NativeRetention(unittest.TestCase):
    def test_fresh_empty_fx_directory_survives_native_cleanup(self):
        source=(STORAGE/'minio.py').read_text(encoding='utf-8')
        tree=ast.parse(source)
        names={'temp_file_last_touched','idle_temp_dirs','remove_empty_dirs'}
        functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
        self.assertEqual({n.name for n in functions},names)
        module=ast.Module(body=functions,type_ignores=[])
        code={'Path':Path}
        exec(compile(module,'native-cleanup-only','exec'),code)
        with tempfile.TemporaryDirectory() as tmp:
            old=Path(tmp)/'old';old.mkdir()
            time.sleep(.025);cutoff=time.time();time.sleep(.025)
            fresh=Path(tmp)/'fx-out-12345678';fresh.mkdir()
            idle=code['idle_temp_dirs']([old,fresh],cutoff)
            self.assertEqual(idle,[old])
            code['remove_empty_dirs'](idle)
            self.assertFalse(old.exists());self.assertTrue(fresh.is_dir())
            (fresh/'windows.mp4').write_bytes(b'output')
            code['remove_empty_dirs']([fresh])
            self.assertEqual((fresh/'windows.mp4').read_bytes(),b'output')

    def test_both_storage_backends_match_reviewed_native_replacement(self):
        contract=json.loads((ROOT/'native-retirements.json').read_text())
        for relative,digest in contract['fxSources'].items():
            source=(STORAGE/Path(relative).name).read_bytes()
            self.assertEqual(hashlib.sha256(source).hexdigest(),digest)
            self.assertNotIn(b'vf-custom:fx-dir-retention',source)
            self.assertIn(b'idle_dirs = idle_temp_dirs(entries, cutoff_time)',source)
            self.assertIn(b'remove_empty_dirs(idle_dirs)',source)

if __name__=='__main__':unittest.main()
