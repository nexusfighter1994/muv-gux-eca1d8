import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('op_install', HERE / 'op-priority-install.py')
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)
NATIVE = ('let ye=(Nt,Yt=null)=>Me.run(t,"ffmpeg",()=>SJ({source:ee,prepared:!0,targetPath:Nt,startTime:pe.start_time,'
          'endTime:pe.end_time,...Yt?{outputFormat:Yt}:{}}));function other(){}')


class OpPriorityInstallTests(unittest.TestCase):
    def test_appends_one_hook_for_the_scheduler(self):
        out = op.patch_node(NATIVE)
        self.assertIn('/* vf-custom:op-priority-v1 */;try{process.getBuiltinModule("module").createRequire(import.meta.url)'
                      '("./vf-custom/op-priority.cjs").installOpPriority(()=>Me)}catch{}', out)
        self.assertEqual(op.patch_node(out), out)

    def test_fails_closed_on_drift(self):
        for text in (NATIVE.replace('prepared:!0', 'prepared:true'), NATIVE + NATIVE.replace('Me.run', 'Xe.run'), 'function a(){}'):
            with self.assertRaises(RuntimeError):
                op.patch_node(text)


if __name__ == '__main__':
    unittest.main()
