import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('lane_install', HERE / 'scheduler-lane-install.py')
lane = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lane)
NATIVE = ('function pX(e){let t=AM.get(e);return t||(t={activeTotal:0,activeByJob:new Map,activeByResource:new Map,'
          'waiters:[],memoryBlocked:!1,memoryWait:null,boostedActive:0},AM.set(e,t)),t}function other(){}')


class SchedulerLaneInstallTests(unittest.TestCase):
    def test_publishes_live_getter_once(self):
        out = lane.patch_node(NATIVE)
        self.assertIn('Object.defineProperty(globalThis,"__vfSchedulerLane",{configurable:true,get(){return pX}})', out)
        self.assertEqual(lane.patch_node(out), out)

    def test_fails_closed_on_drift(self):
        for text in (NATIVE.replace('waiters:[]', 'queue:[]'), NATIVE + NATIVE.replace('pX', 'qX'), 'function a(){}'):
            with self.assertRaises(RuntimeError):
                lane.patch_node(text)


if __name__ == '__main__':
    unittest.main()
