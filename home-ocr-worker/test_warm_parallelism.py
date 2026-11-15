import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

TARGET=Path(__file__).with_name('service.py')
spec=importlib.util.spec_from_file_location('ocr_service_under_test',TARGET)
service=importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

class ParallelismTests(unittest.TestCase):
    def test_warm_requests_use_four_independent_instances_with_exact_native_inputs(self):
        engines=[];calls=[];owners=[]
        class Engine:
            def __init__(self,**kwargs):engines.append(kwargs)
            def prepare(self):pass
        class Service:
            def __init__(self,settings,engine,workers):self.engine=engine;self.workers=workers
            async def run(self,body):
                calls.append((self.engine,self.workers,body))
                return {'model':'rapidocr','results':[]}
        body={'images':[{'id':'one','data_base64':'YQ=='}],'recognize':True,'max_side':1600}
        native=ModuleType('app.ocr');native.OcrService=Service;native.RapidOcrEngine=Engine
        schema=ModuleType('app.schemas');schema.OcrRequest=SimpleNamespace(model_validate=lambda b:b)
        pool=ModuleType('warm_pool');pool.CONTRACT='test';pool.watch_parent=lambda pid,fn:owners.append(pid)
        stdin=SimpleNamespace(buffer=io.BytesIO((json.dumps(body)+'\n'+json.dumps(body)+'\n').encode()))
        with patch.dict(sys.modules,{'app.ocr':native,'app.schemas':schema,'warm_pool':pool}),patch.object(service,'verify_models',return_value=service.MODELS),patch.object(sys,'stdin',stdin),contextlib.redirect_stdout(io.StringIO()):
            service.warm_child(123)
        self.assertEqual(engines,[{'max_instances':4}])
        self.assertEqual([call[1] for call in calls],[4,4])
        self.assertIs(calls[0][0],calls[1][0])
        self.assertEqual([call[2] for call in calls],[body,body])
        self.assertEqual(owners,[123])

    def test_parent_slots_cold_fallback_and_owned_deadlines_are_unchanged(self):
        text=TARGET.read_text()
        self.assertIn('self.slots = threading.BoundedSemaphore(OCR_SLOTS)',text)
        self.assertIn('OCR_SLOTS = 4',text)
        self.assertIn("RapidOcrEngine(max_instances=2), workers=2)",text)
        self.assertIn("if remaining<=0: raise TimeoutError('OCR deadline')",text)
        self.assertIn('if proc.poll() is None: proc.kill()',text)
        self.assertIn('proc.communicate()',text)

if __name__=='__main__':unittest.main()
