import pathlib, runpy, unittest

patch = runpy.run_path(str(pathlib.Path(__file__).parents[1] / 'source-text-alignment-install.py'))['patch_node']
SOURCE = '''function POn(e,t){let r=oc(t);if(!Number.isFinite(r)||r<=0)throw new Error("partitionSourceTimelineCuts: durationSeconds must be positive");return e}
async function LOn(e){let{jobId:t,priorResults:r,emit:n,setStageDetail:o,checkAbort:i,nowIso:s}=e;
let Y=OUt(G.words),J,K=!1;try{J=U?$On({scriptChunks:w,durationSeconds:N,language:u}):C7e({words:Y})}catch(e){throw e}
let X=I7e({intake:c,snapshot:e.generationSnapshot??null,recordedCleanupMode:I?.cleanupMode??null}),{cuts:Z,keptChunkPauses:te}=k_s({aligned:J,durationSeconds:N,preserveSourceTiming:X,onFallback:e=>n(e)});return Z}'''

class AlignmentInstall(unittest.TestCase):
    def test_scoped_and_idempotent(self):
        value = patch(SOURCE)
        self.assertEqual(patch(value), value)
        self.assertIn('aligned:/* vf-custom:source-text-alignment-v1 */X&&!U?await', value)
        self.assertIn('partition:POn,checkAbort:i,', value)
        self.assertTrue(value.startswith(SOURCE.split('\n')[0]))
        self.assertIn('words:OUt(G.words),scriptChunks:w,language:u', value)
    def test_drift_rejected(self):
        with self.assertRaises(RuntimeError): patch(SOURCE.replace('checkAbort:i', 'changed:i'))
    def test_duplicate_rejected(self):
        with self.assertRaises(RuntimeError): patch(SOURCE + SOURCE)
    def test_partial_rejected(self):
        with self.assertRaises(RuntimeError): patch(SOURCE + '/* vf-custom:source-text-alignment-v1 */')
    def test_tamper_rejected(self):
        with self.assertRaises(RuntimeError): patch(patch(SOURCE).replace('partition:POn,checkAbort:i,', 'partition:POn,checkAbort:n,'))

if __name__ == '__main__': unittest.main()
