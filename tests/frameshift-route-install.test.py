import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE = {
    'render.js': 'export async function render({ compositionHtml }) { return "native:" + compositionHtml; }\n',
    'hyperframes-cli.js': 'export async function runRender(params) { return { code: 0, which: "native" }; }\n',
    'project.js': 'export async function materializeProject(workDir, compositionHtml) { return { projectDir: workDir }; }\n',
}


class Installation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = {}
        source = ROOT / 'frameshift-route-install.py'
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), cls.module)

    def library(self, files=FAKE):
        directory = Path(tempfile.mkdtemp(prefix='vf-fslib-'))
        self.addCleanup(shutil.rmtree, directory, True)
        for name, text in files.items():
            (directory / name).write_text(text, encoding='utf-8')
        (directory / 'package.json').write_text('{"type":"module"}', encoding='utf-8')
        return directory

    def test_trampolines_call_route_when_installed_and_original_otherwise(self):
        lib = self.library()
        self.assertEqual(set(self.module['patch_library'](lib).values()), {True})
        self.assertEqual(set(self.module['patch_library'](lib).values()), {False}, 'idempotent')
        url = (lib / 'render.js').as_uri()
        program = f'''const assert=require("node:assert/strict");(async()=>{{
          const m=await import({json.dumps(url)});const cli=await import({json.dumps((lib / 'hyperframes-cli.js').as_uri())});
          assert.equal(await m.render({{compositionHtml:"a"}}),"native:a");
          const seen=[];globalThis.__vfFrameshiftRoute={{call:(name,original,self,args)=>{{seen.push(name);return Reflect.apply(original,self,args).then(v=>"routed:"+v)}}}};
          assert.equal(await m.render({{compositionHtml:"b"}}),"routed:native:b");
          assert.equal((await cli.runRender({{}})),"routed:[object Object]");
          assert.deepEqual(seen,["render","runRender"]);}})().catch(e=>{{console.error(e);process.exit(1)}});'''
        result = subprocess.run(['node', '-e', program], capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_library_drift_is_fatal(self):
        for name, text in [('render.js', 'export async function render(options) {}\n'),
                           ('project.js', FAKE['project.js'] + 'materializeProject = null;\n')]:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'fingerprint'):
                self.module['patch_library_file'](text, name)
        patched = self.module['patch_library_file'](FAKE['render.js'], 'render.js')
        with self.assertRaisesRegex(RuntimeError, 'drifted'):
            self.module['patch_library_file'](patched.replace('globalThis.__vfFrameshiftRoute', 'x'), 'render.js')

    def test_real_library_files(self):
        source = os.environ.get('VF_FRAMESHIFT_LIB')
        if not source:
            self.skipTest('VF_FRAMESHIFT_LIB not set')
        lib = self.library({name: (Path(source) / name).read_text(encoding='utf-8') for name in FAKE})
        self.module['patch_library'](lib)
        for name in FAKE:
            result = subprocess.run(['node', '--check', str(lib / name)], capture_output=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, name + result.stderr)

    def test_bundle_hook(self):
        stock = os.environ.get('VF_STOCK_BUNDLE')
        if not stock:
            self.skipTest('VF_STOCK_BUNDLE not set')
        text = Path(stock).read_text(encoding='utf-8')
        patched = self.module['patch_node'](text)
        self.assertEqual(self.module['patch_node'](patched), patched)
        self.assertIn('__vfCustom.installFrameshiftRoute({RU:()=>RU(),getStore:()=>fhe.getStore()', patched)
        result = subprocess.run(['node', '--check', '--input-type=module'], input=patched, capture_output=True, encoding='utf-8', timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.assertRaisesRegex(RuntimeError, 'anchor'):
            self.module['patch_node'](text.replace('function RU(){return Jbr.getStore()?.jobId||null}', 'function RU(){return null}'))


if __name__ == '__main__':
    unittest.main()
