import importlib.util
from pathlib import Path
import unittest
import sys
import ast

path = Path(__file__).with_name('service.py')
spec = importlib.util.spec_from_file_location('home_ocr_service', path) if path.exists() else None
service = importlib.util.module_from_spec(spec) if spec else None
if service:
    spec.loader.exec_module(service)

class ContractTests(unittest.TestCase):
    def test_child_parallelism_is_bounded_and_instances_are_separate(self):
        tree=ast.parse(path.read_text())
        child=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='child')
        calls=[n for n in ast.walk(child) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name)]
        for name,keyword in [('RapidOcrEngine','max_instances'),('OcrService','workers')]:
            call=next(n for n in calls if n.func.id==name)
            self.assertEqual(ast.literal_eval(next(k.value for k in call.keywords if k.arg==keyword)),2)
        gates=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='BoundedSemaphore']
        self.assertEqual([ast.unparse(n.args[0]) for n in gates],['OCR_SLOTS'])
        slots=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)=='OCR_SLOTS' for t in n.targets))
        self.assertTrue(1<=slots<=8 and slots==4)

    def test_inline_payload_preserves_quality(self):
        self.assertIsNotNone(service, 'OCR sidecar is missing')
        body = {'images': [{'id':'a','data_base64':'YQ=='}], 'recognize':True,'max_side':1600}
        self.assertEqual(service.validate_body(body), body)

    def test_reject_urls_duplicates_quality_changes_and_unbounded_deadline(self):
        self.assertIsNotNone(service, 'OCR sidecar is missing')
        for body in [{'images':[{'id':'a','image_url':'http://elsewhere'}]}, {'images':[{'id':'a','data_base64':'YQ=='},{'id':'a','data_base64':'YQ=='}]}, {'images':[{'id':'a','data_base64':'YQ=='}],'max_side':99999}, {'images':[]}]:
            with self.assertRaises(ValueError): service.validate_body(body)
        self.assertEqual(service.deadline_seconds(9999999),360)
        self.assertEqual(service.deadline_seconds(1000),1)

    def test_auth_constant_time_and_no_empty_token(self):
        self.assertIsNotNone(service, 'OCR sidecar is missing')
        self.assertFalse(service.authorized('', ''))
        self.assertFalse(service.authorized('Bearer wrong', 'x'*32))
        self.assertTrue(service.authorized('Bearer '+'x'*32, 'x'*32))

    def test_owned_process_timeout_and_disconnect_are_reaped(self):
        self.assertTrue(hasattr(service, 'run_owned'))
        args=[sys.executable,'-c','import time;time.sleep(20)']
        for seconds, disconnected in [(.05,lambda:False),(3,lambda:True)]:
            with self.assertRaises((TimeoutError, ConnectionAbortedError)):
                service.run_owned(args,b'{}',seconds,disconnected)

if __name__ == '__main__': unittest.main()
