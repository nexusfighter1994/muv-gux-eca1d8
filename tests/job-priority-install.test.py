import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
# Exact native shapes from stock 2026.10.13.7.
NATIVE = '''let jp,AM,Q,drained=0;
function Axt(e){return jp.get(e)?.priority??lxt}
function pX(e){let t=AM.get(e);return t||(t={activeTotal:0,activeByJob:new Map,waiters:[]},AM.set(e,t)),t}
function AUi(e){return {}}function yUi(e){return progressFor(e.pipelineRow.job_id)}
function qCt(e,t=null){let r=t||Q.prepare("SELECT * FROM pipeline_jobs WHERE job_id = ?").get(e);return r?yUi({pipelineRow:r,...AUi(e)}):null}
async function IT(e){drained++}async function RT(){await Promise.all([...AM.keys()].map(e=>IT(e)))}
'''


class Installation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = {}
        source = ROOT / 'job-priority-install.py'
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), cls.module)

    def patch(self, text=NATIVE):
        return self.module['patch_node'](text)

    def test_late_scheduler_init_and_real_helper(self):
        helper = json.dumps(str(ROOT / 'node' / 'job-priority.cjs'))
        program = ('const assert=require("node:assert/strict");const lxt="\\uFFFF";let manager;'
                   'const progressFor=id=>id==="near"?{basis:"chunk-composition",totalChunks:82,completedChunks:51}:{basis:"segments",totalSegments:9,completedSegments:1};'
                   f'const __vfCustom={{installJobPriority:n=>(manager=require({helper}).createJobPriority({{...n,setTimer:()=>({{}})}})),'
                   'report:(k,ok,e)=>{if(!ok)throw Error(e)}};\n' + self.patch() +
                   '\n// scheduler initialises AFTER the tail hook\n'
                   'jp=new Map([["fresh",{priority:"2026-10-11T18:16:35Z|a|fresh"}],["near",{priority:"2026-10-11T18:22:54Z|a|near"}]]);'
                   'AM=new Map([["render",{waiters:[{jobId:"near",priority:"2026-10-11T18:22:54Z|a|near"}]}]]);'
                   'Q={prepare:sql=>({get:id=>sql.includes("pipeline_jobs")?{job_id:id}:{started_at:"2026-10-14T00:00:00Z",queued_at:"q"}})};'
                   'assert.equal(manager.tick(),2);assert.ok(jp.get("near").priority<jp.get("fresh").priority);'
                   'assert.equal(AM.get("render").waiters[0].priority,jp.get("near").priority);'
                   'setImmediate(()=>assert.equal(drained,1));')
        result = subprocess.run(['node', '-e', program], capture_output=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_idempotent_duplicate_and_drift(self):
        patched = self.patch()
        self.assertEqual(self.patch(patched), patched)
        with self.assertRaisesRegex(RuntimeError, 'duplicated'):
            self.patch(patched + self.module['MARKER'])
        for old, new in [('?.priority??lxt', '?.prio??lxt'), ('FROM pipeline_jobs', 'FROM jobs'), ('[...AM.keys()]', '[...BM.keys()]')]:
            with self.subTest(old=old), self.assertRaisesRegex(RuntimeError, 'fingerprint'):
                self.patch(NATIVE.replace(old, new))

    def test_optional_exact_stock(self):
        if not os.environ.get('VF_STOCK_BUNDLE'):
            self.skipTest('VF_STOCK_BUNDLE not set')
        patched = self.patch(Path(os.environ['VF_STOCK_BUNDLE']).read_text(encoding='utf-8'))
        self.assertIn('getJobs:()=>jp,getLanes:()=>AM,progress:e=>qCt(e),getDb:()=>Q,wake:()=>{RT()', patched)
        result = subprocess.run(['node', '--check', '--input-type=module'], input=patched,
                                capture_output=True, encoding='utf-8', timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
