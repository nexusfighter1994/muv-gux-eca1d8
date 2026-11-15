import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent
MODULE = ROOT / 'surplus-vision-budget-install.py'
ANCHOR = 'f.model=e.modelOverridden?a:kp,Number(f.max_tokens)>0||(f.max_tokens=Lvn(o)),$te('


def patch(source):
    if not MODULE.exists():
        return source
    spec = importlib.util.spec_from_file_location('budget_install', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.patch_node(source)


class InstallerContract(unittest.TestCase):
    def test_native_request_uses_the_targeted_budget_without_changing_other_fields(self):
        source = 'function send(e,o,r){let a=e.model,kp="gpt-5.6-luna",f={request_id:"original",messages:["original"],temperature:0},Lvn=()=>16384,$te=x=>x;return ' + ANCHOR + '{payload:f,signal:r.signal,timeoutMs:123456})}'
        helper = 'const __vfCustom={surplusOutputBudget:(s,k,p,n)=>s.model==="deepseek-v4.1-flash"&&s.effort==="high"&&p==="vision"?65536:n};'
        code = helper + patch(source) + ';console.log(JSON.stringify(send({model:"deepseek-v4.1-flash",modelOverridden:true,effort:"high"},"brollSegmentScorerFrames",{pipelineId:"vision",signal:"original-signal"})));'
        out = json.loads(subprocess.check_output([os.environ.get('VF_TEST_NODE', 'node'), '-e', code], text=True))
        self.assertEqual(out['payload']['max_tokens'], 65536)
        self.assertEqual(out['payload']['messages'], ['original'])
        self.assertEqual(out['payload']['request_id'], 'original')
        self.assertEqual(out['signal'], 'original-signal')
        self.assertEqual(out['timeoutMs'], 123456)

    def test_fingerprint_is_unique_and_repeat_application_is_idempotent(self):
        once = patch(ANCHOR)
        self.assertEqual(patch(once), once)
        for text in ['', ANCHOR + ANCHOR, ANCHOR.replace('Lvn(o)', 'changed(o)')]:
            with self.assertRaises(RuntimeError):
                patch(text)


if __name__ == '__main__':
    unittest.main()
