import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
NATIVE = '''let active=0;const _Y=()=>2;
function lbi(e,t,r){return e==="render"&&r==="frameshift"?Math.min(t,_Y()):t}
'''
PRELUDE = ("const assert=require('node:assert/strict');"
           "const __vfCustom={homeRemoteActive:r=>r==='frameshift'?active:0,report:(n,ok,e)=>{if(!ok)throw Error(e)}};\n")


class Installation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = {}
        source = ROOT / 'home-graphics-capacity-install.py'
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), cls.module)

    def patch(self, text=NATIVE):
        return self.module['patch_node'](text)

    def test_cap_follows_home_remote_count(self):
        result = subprocess.run(['node', '-e', PRELUDE + self.patch() + '''
          assert.equal(lbi("render",5,"frameshift"),2);active=1;assert.equal(lbi("render",6,"frameshift"),3);
          assert.equal(lbi("render",2,"frameshift"),2,"never above the lane size");
          assert.equal(lbi("render",6,"remotion"),6);assert.equal(lbi("ffmpeg",14,"frameshift"),14);'''],
                                capture_output=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_idempotent_duplicate_and_drift(self):
        patched = self.patch()
        self.assertEqual(self.patch(patched), patched)
        with self.assertRaisesRegex(RuntimeError, 'duplicated'):
            self.patch(patched + self.module['MARKER'])
        for text in [NATIVE.replace('Math.min(t,_Y())', 'Math.max(t,_Y())'), NATIVE + NATIVE.replace('lbi', 'lbj')]:
            with self.assertRaisesRegex(RuntimeError, 'fingerprint'):
                self.patch(text)

    def test_optional_exact_stock(self):
        if not os.environ.get('VF_STOCK_BUNDLE'):
            self.skipTest('VF_STOCK_BUNDLE not set')
        patched = self.patch(Path(os.environ['VF_STOCK_BUNDLE']).read_text(encoding='utf-8'))
        result = subprocess.run(['node', '--check', '--input-type=module'], input=patched,
                                capture_output=True, encoding='utf-8', timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
