import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def test_closed_native_bindings_and_idempotence(self):
        path = ROOT / 'home-media-install.py'
        self.assertTrue(path.exists(), 'installer missing')
        spec = importlib.util.spec_from_file_location('media_install', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = '\n'.join(module.SIGNATURES)
        patched = module.patch_node(source)
        self.assertEqual(module.patch_node(patched), patched)
        self.assertIn('pc_node_media_cli.py', patched)
        self.assertIn('leases.set("ffmpeg",{...old,boosted:false})', patched)
        with self.assertRaises(RuntimeError):
            module.patch_node(source.replace(module.SIGNATURES[0], ''))


if __name__ == '__main__':
    unittest.main()
