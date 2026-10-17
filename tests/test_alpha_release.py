import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

BUILDER = Path(__file__).resolve().parents[1] / 'home-graphics-worker/prepare-alpha-release.mjs'

class ReleaseTests(unittest.TestCase):
    def test_mutable_python_caches_are_never_copied_or_pinned(self):
        with tempfile.TemporaryDirectory() as tmp:
            base, new = Path(tmp)/'old', Path(tmp)/'new'
            (base/'motion-offload').mkdir(parents=True)
            (base/'map-offload').mkdir()
            (base/'shared-graphics-worker').mkdir()
            files = {}
            for name in ['node','ffmpeg','ffprobe','browser','cli','renderModule']:
                file = base/name
                file.write_text('immutable fixture')
                files[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
            config = dict(contract='old-test-only', files=files,
                          **{name:str(base/name) for name in ['node','ffmpeg','ffprobe','browser','cli','renderModule']})
            (base/'motion-offload/runtime.json').write_text(json.dumps(config))
            (base/'map-offload/runtime.json').write_text(json.dumps(dict(contract='map-test-only',files=files,node=str(base/'node'))))
            for name in ['worker.mjs','service.py']:
                (base/'map-offload'/name).write_text('fixture')
            (base/'shared-graphics-worker/worker.patched.py').write_text('fixture')
            cache=base/'motion-offload/__pycache__'
            cache.mkdir()
            (cache/'transport.cpython-313.pyc').write_bytes(b'mutable')
            result=subprocess.run(['node',str(BUILDER),str(base),str(new)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            manifest=json.loads((new/'motion-offload/runtime.json').read_text())
            self.assertFalse(any('__pycache__' in p or p.endswith('.pyc') for p in manifest['files']))
            self.assertFalse((new/'motion-offload/__pycache__').exists())
            self.assertIn(str(new/'motion-offload/transport.py'),manifest['files'])

if __name__ == '__main__':
    unittest.main()
