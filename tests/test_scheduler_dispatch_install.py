import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('dispatch_install', HERE / 'scheduler-dispatch-install.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
NATIVE = ('function ubi(e,t,r,n){let o=null;for(let i of t.waiters){let a=XBe(e,i.jobId,r,i.resourceKey,i.priority);'
          'if(a===null)return{waiter:i,reason:null};if(o=a,!(a==="resource"&&n))return{waiter:null,reason:a}}return{waiter:null,reason:o}}'
          'function other(){}')


class SchedulerDispatchInstallTests(unittest.TestCase):
    def test_publishes_live_getter_and_setter_once(self):
        out = dispatch.patch_node(NATIVE)
        self.assertIn('Object.defineProperty(globalThis,"__vfSchedulerDispatch",{configurable:true,get(){return ubi},set(v){ubi=v}})', out)
        self.assertEqual(dispatch.patch_node(out), out)

    def test_fails_closed_on_drift(self):
        for text in (NATIVE.replace('i.priority', 'i.prio'), NATIVE + NATIVE.replace('ubi', 'vbi'), 'function a(){}'):
            with self.assertRaises(RuntimeError):
                dispatch.patch_node(text)


if __name__ == '__main__':
    unittest.main()
