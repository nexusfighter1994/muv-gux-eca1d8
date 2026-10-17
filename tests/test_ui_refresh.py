import importlib.util
from pathlib import Path
import tempfile
import unittest


class ExistingCustomUiTests(unittest.TestCase):
    def test_existing_custom_install_refreshes_control_assets_without_duplicates(self):
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('vf_apply_ui_test', root / 'apply.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            public = Path(temporary)
            (public / 'assets').mkdir()
            index = public / 'index.html'
            index.write_text('<head><!-- vf-custom -->'
                '<script type="module" src="/assets/pc-boost-settings-20261002.js?v=vfc1"></script>'
                '<link rel="stylesheet" href="/assets/pc-boost-settings-20261002.css?v=vfc1">'
                '<script type="module" src="/assets/vf-custom-tab.js?v=vfc1"></script></head>')
            module.PUBLIC = public
            module.ui()
            once = index.read_text()
            self.assertIn('pc-boost-settings-20261002.js?v=motion-share-20261017b', once)
            self.assertIn('pc-transfer-settings-20261011.js?v=size-nvenc-20261013a', once)
            self.assertIn('pc-transfer-settings-20261011.css?v=size-20261011b', once)
            module.ui()
            self.assertEqual(index.read_text(), once)
            self.assertEqual(once.count('pc-transfer-settings-20261011.js'), 1)


if __name__ == '__main__':
    unittest.main()
