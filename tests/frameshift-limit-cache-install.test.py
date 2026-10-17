import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
# Exact native shapes from stock 2026.10.13.7 (index.mjs lines 843/844).
NATIVE = '''let reads=0,store={frameshiftConcurrencyLimit:2};
const Q={prepare:sql=>({get:()=>{reads++;return {value_json:JSON.stringify(store)}},run:({value})=>{store=JSON.parse(value)}})};
function TDr(){return Q.prepare("SELECT value_json FROM app_settings WHERE key = ?").get("general")?.value_json??null}
function Tr(){return JSON.parse(TDr())}
function umi(){return Tr()}function ZJe(){return Tr()}function NDe(){}
function SDe(e){let t=Number(e);return Number.isSafeInteger(t)&&t>=1&&t<=8?t:2}function _Y(){return SDe(Tr().frameshiftConcurrencyLimit)}function kDe(e){let t=SDe(e);return en({frameshiftConcurrencyLimit:t}),t}
function lbi(e,t,r){return e==="render"&&r==="frameshift"?Math.min(t,_Y()):t}
function en(e){let t=umi();Q.prepare(`INSERT INTO app_settings (key, value_json) VALUES ('general', @value)
     ON CONFLICT(key) DO UPDATE SET value_json = @value`).run({value:JSON.stringify({...t,...e})}),NDe()}
function wao(e){let t=ZJe();Q.prepare(`INSERT INTO app_settings (key, value_json) VALUES ('general', @value)
     ON CONFLICT(key) DO UPDATE SET value_json = @value`).run({value:JSON.stringify({...t,...e})})}
'''
PRELUDE = "const assert=require('node:assert/strict');const __vfCustom={report:(n,ok,e)=>{if(!ok)throw Error(e)}};\n"


class Installation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = {}
        source = ROOT / 'frameshift-limit-cache-install.py'
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), cls.module)

    def patch(self, text=NATIVE):
        return self.module['patch_node'](text)

    def run_js(self, checks):
        result = subprocess.run(['node', '-e', PRELUDE + self.patch() + checks],
                                capture_output=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_repeated_admission_checks_read_settings_once(self):
        self.run_js('''for(let i=0;i<500;i++)assert.equal(lbi("render",5,"frameshift"),2);
          assert.equal(reads,1);assert.equal(globalThis.__vfFrameshiftLimitCache.hits,499);''')

    def test_native_limit_setter_is_visible_immediately(self):
        self.run_js('''assert.equal(_Y(),2);assert.equal(kDe(3),3);assert.equal(_Y(),3);
          assert.equal(lbi("render",5,"frameshift"),3);''')

    def test_second_general_writer_also_invalidates(self):
        self.run_js('''assert.equal(_Y(),2);wao({frameshiftConcurrencyLimit:4});assert.equal(_Y(),4);''')

    def test_external_writes_expire_within_one_second(self):
        self.run_js('''assert.equal(_Y(),2);store={frameshiftConcurrencyLimit:5};assert.equal(_Y(),2);
          const t=Date.now()+1001;while(Date.now()<t);assert.equal(_Y(),5);''')

    def test_writer_error_still_invalidates(self):
        self.run_js('''assert.equal(_Y(),2);store={frameshiftConcurrencyLimit:6};
          const real=JSON.stringify;JSON.stringify=()=>{throw Error("boom")};
          assert.throws(()=>en({x:1}),/boom/);JSON.stringify=real;assert.equal(_Y(),6);''')

    def test_other_lanes_never_read_the_limit(self):
        self.run_js('''assert.equal(lbi("ffmpeg",14,"frameshift"),14);assert.equal(lbi("render",5,"remotion"),5);
          assert.equal(reads,0);''')

    def test_idempotent_and_duplicate_marker_fatal(self):
        patched = self.patch()
        self.assertEqual(self.patch(patched), patched)
        with self.assertRaisesRegex(RuntimeError, 'duplicated'):
            self.patch(patched + self.module['MARKER'])

    def test_missing_or_ambiguous_fingerprint_is_fatal(self):
        for text in [NATIVE.replace('.frameshiftConcurrencyLimit)}function kDe', '.otherLimit)}function kDe'),
                     NATIVE + 'function _Z(){return SDe(Tr().frameshiftConcurrencyLimit)}',
                     NATIVE.replace("VALUES ('general', @value)", "VALUES ('other', @value)")]:
            with self.subTest(text=text[-80:]), self.assertRaisesRegex(RuntimeError, 'fingerprints'):
                self.patch(text)

    def test_hook_syntax_and_optional_exact_stock(self):
        sources = [NATIVE]
        if os.environ.get('VF_STOCK_BUNDLE'):
            sources.append(Path(os.environ['VF_STOCK_BUNDLE']).read_text(encoding='utf-8'))
        for source in sources:
            patched = self.patch(source)
            self.assertEqual(self.patch(patched), patched)
            result = subprocess.run(['node', '--check', '--input-type=module'],
                                    input=patched, capture_output=True, encoding='utf-8', timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
