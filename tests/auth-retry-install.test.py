import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
# Native shapes from the loaded bundle of 2026-11-17 (names shortened).
NATIVE = '''var YOa,KOa,E1o;const Oe={isJobAborted:e=>e==="gone"};
async function Kds(e){let s=()=>{if(Oe.isJobAborted(e)){let l=new Error("Render job stopped");throw l.name="PipelineCanceledError",l}};s()}
const Vxo={dispatchSegment:async a=>__native(a)};
E1o=15e3;({dispatchSegment:YOa}=Vxo);KOa=/x/;
async function chunk(n,r){let te;try{te||(te=await YOa({job:n,jobId:r}))}catch(ne){throw ne}return te}
'''


class Installation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = {}
        source = ROOT / 'auth-retry-install.py'
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), cls.module)

    def patch(self, text=NATIVE):
        return self.module['patch_node'](text)

    def test_names_and_single_idempotent_hook(self):
        self.assertEqual(self.module['names'](NATIVE), {'dispatch': 'YOa', 'source': 'Vxo', 'scheduler': 'Oe'})
        once = self.patch()
        self.assertEqual(once.count(self.module['MARKER']), 1)
        self.assertEqual(self.patch(once), once)
        self.assertIn('({dispatchSegment:YOa}=Vxo);/* vf-custom:auth-retry-v1 */try{YOa=__vfCustom.wrapDispatchAuthRetry(YOa,', once)
        self.assertIn(';KOa=/x/;', once)

    def test_missing_or_ambiguous_fingerprints_fail(self):
        for broken in (NATIVE.replace('({dispatchSegment:YOa}=Vxo);', ''),
                       NATIVE + '({dispatchSegment:Zzz}=Vxo);',
                       NATIVE.replace('await YOa({job:', 'await other({job:'),
                       NATIVE.replace('new Error("Render job stopped")', 'new Error("x")'),
                       self.patch() + '/* vf-custom:auth-retry-v1 */'):
            with self.assertRaises(RuntimeError):
                self.patch(broken)

    def test_patched_code_retries_with_the_real_helper(self):
        helper = json.dumps(str(ROOT / 'node' / 'auth-retry.cjs'))
        program = ('const assert=require("node:assert/strict");const A=require(' + helper + ');'
                   'const reports=[];let calls=0;'
                   'globalThis.__vfCustom={report:(n,ok,d)=>reports.push([n,ok,d||""]),'
                   'wrapDispatchAuthRetry:(orig,native)=>A.wrapDispatch(orig,{isAborted:native.isAborted,sleep:async()=>{},read:()=>A.DEFAULTS,log:()=>{}})};'
                   'const __native=async a=>{calls++;if(calls===1){const e=new Error("Render authorization is temporarily unavailable.");'
                   'e.code="authorization_unavailable";e.pauseRun=true;throw e}return {status:"succeeded",jobId:a.jobId}};'
                   + self.patch() +
                   '(async()=>{const r=await chunk({}, "job-1");assert.deepEqual(r,{status:"succeeded",jobId:"job-1"});assert.equal(calls,2);'
                   'assert.deepEqual(reports,[["authRetry",true,""]]);assert.equal(YOa.__vfAuthRetry,true);'
                   'calls=0;await assert.rejects(()=>chunk({}, "gone"),/temporarily unavailable/);assert.equal(calls,1);'
                   'console.log("ok")})().catch(e=>{console.error(e);process.exit(1)})')
        done = subprocess.run(['node', '-e', program], capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), 'ok')

    def test_a_failing_helper_keeps_the_native_dispatcher(self):
        program = ('const assert=require("node:assert/strict");const reports=[];'
                   'globalThis.__vfCustom={report:(n,ok,d)=>reports.push([n,ok]),wrapDispatchAuthRetry:()=>{throw new Error("helper missing")}};'
                   'const __native=async a=>({status:"succeeded"});'
                   + self.patch() +
                   '(async()=>{assert.deepEqual(await chunk({}, "job-1"),{status:"succeeded"});assert.deepEqual(reports,[["authRetry",false]]);'
                   'console.log("ok")})().catch(e=>{console.error(e);process.exit(1)})')
        done = subprocess.run(['node', '-e', program], capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == '__main__':
    unittest.main()
