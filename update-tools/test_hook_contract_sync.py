import runpy
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class HookContractSyncTests(unittest.TestCase):
    def test_build_and_image_gates_share_reviewed_contract(self):
        build = runpy.run_path(str(ROOT / 'validate-hook-report.py'))
        image = runpy.run_path(str(ROOT / 'update-tools/validate-hook-report.py'))
        for key in ('CONTRACT_VERSION', 'REQUIRED_HOOKS', 'OPTIONAL_HOOKS'):
            self.assertEqual(build[key], image[key], key)

    def test_image_gate_requires_existing_thumbnail_guard(self):
        gate = runpy.run_path(str(ROOT / 'update-tools/validate-hook-report.py'))
        report = dict.fromkeys(gate['REQUIRED_HOOKS'], 'ok')
        report.pop('node.thumbnailResultGuard', None)
        with self.assertRaisesRegex(gate['HookReportError'], 'thumbnailResultGuard'):
            gate['validate_hook_report']({'report': report})

    def test_image_gate_requires_surplus_market_retry(self):
        gate = runpy.run_path(str(ROOT / 'update-tools/validate-hook-report.py'))
        report = dict.fromkeys(gate['REQUIRED_HOOKS'], 'ok')
        report.pop('node.surplusMarketplaceRetry')
        with self.assertRaisesRegex(gate['HookReportError'], 'surplusMarketplaceRetry'):
            gate['validate_hook_report']({'report': report})


if __name__ == '__main__':
    unittest.main()
