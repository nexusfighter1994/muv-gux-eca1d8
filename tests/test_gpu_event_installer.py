import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).resolve().parent.parent/'apply.py'
spec=importlib.util.spec_from_file_location('gpu_event_installer',path)
installer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_native_event_bus_hook_is_unique_idempotent_and_update_safe(self):
        method=getattr(installer,'gpu_render_events',None)
        self.assertTrue(callable(method),'persistent GPU event hook is not implemented')
        source='function abc({jobId:a=null,chunkId:b=null,message:c,data:d=null}={}){let e={};return xyz.emit("event",e),e}var init=()=>{s=db.prepare(`INSERT INTO events (job_id)`)};'
        result=method(source)
        self.assertIn('getEmitter:()=>xyz,emit:abc',result)
        self.assertEqual(method(result),result)
        self.assertEqual(method('unrelated upstream code'),'unrelated upstream code')


if __name__=='__main__':unittest.main()
