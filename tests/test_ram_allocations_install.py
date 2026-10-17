import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('ram_install', HERE / 'ram-allocations-install.py')
ram = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ram)
NATIVE = ('var UL,wxa;function Fxa({lane:e,resourceKey:t}){let l=1,c=++wxa;'
          'UL.set(c,{laneKey:e,resourceKey:t,estimateMb:l,grantedAtMs:bh()});}'
          'var init=()=>{zve=null;UL=new Map,wxa=0};')


class RamAllocationsInstallTests(unittest.TestCase):
    def test_publishes_live_getter_once(self):
        out = ram.patch_node(NATIVE)
        self.assertIn('Object.defineProperty(globalThis,"__vfRamAllocations",{configurable:true,get(){return UL}})', out)
        self.assertEqual(ram.patch_node(out), out)
        self.assertEqual(out.count(ram.MARKER), 1)

    def test_fails_closed_on_drift(self):
        for text in (NATIVE.replace('grantedAtMs:bh()', 'grantedAt:bh()'), NATIVE + NATIVE, NATIVE.replace('UL=new Map', 'UL=new WeakMap')):
            with self.assertRaises(RuntimeError):
                ram.patch_node(text)
        with self.assertRaises(RuntimeError):
            ram.patch_node(ram.patch_node(NATIVE) + ram.MARKER)


if __name__ == '__main__':
    unittest.main()
