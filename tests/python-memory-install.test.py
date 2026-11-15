import ast
from pathlib import Path
import runpy
import unittest

class InstallerTests(unittest.TestCase):
    def setUp(self):
        path=Path(__file__).with_name('python-memory-install.py')
        if not path.exists():path=Path(__file__).resolve().parents[1]/'python-memory-install.py'
        self.assertTrue(path.exists(),'Missing exact lifecycle installer')
        self.patch=runpy.run_path(str(path))['patch_source']
        self.source='from __future__ import annotations\nclass Worker:\n    async def task(self, value):\n        return value\n'

    def test_only_import_and_decorator_changed(self):
        result=self.patch(self.source,[('Worker','task')])
        tree=ast.parse(result);original=ast.parse(self.source)
        tree.body.pop(1);tree.body[1].body[0].decorator_list=[]
        self.assertEqual(ast.dump(tree),ast.dump(original))

    def test_idempotent(self):
        one=self.patch(self.source,[('Worker','task')])
        self.assertEqual(self.patch(one,[('Worker','task')]),one)

    def test_missing_target_fails_closed(self):
        with self.assertRaises(ValueError):self.patch(self.source,[('Worker','missing')])

    def test_sync_target_fails_closed(self):
        with self.assertRaises(ValueError):self.patch(self.source.replace('async def','def'),[('Worker','task')])

    def test_partial_marker_fails_closed(self):
        with self.assertRaises(ValueError):self.patch(self.source+'\n# vf-custom:python-memory-reclaim-v1\n',[('Worker','task')])

    def test_existing_decorators_stay_outside(self):
        source='@route("/test")\nasync def task(request):\n    return request\n'
        result=self.patch(source,[(None,'task')])
        node=ast.parse(result).body[1]
        self.assertEqual(len(node.decorator_list),2)
        self.assertEqual(ast.unparse(node.decorator_list[0]),"route('/test')")
        self.assertEqual(ast.unparse(node.decorator_list[1]),'_vf_after_task')

if __name__=='__main__':unittest.main()
