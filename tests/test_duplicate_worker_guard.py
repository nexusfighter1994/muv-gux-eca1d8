import importlib.util
from pathlib import Path
import sys
import unittest

HELPERS = Path(__file__).resolve().parents[1] / 'helpers'
sys.path.insert(0, str(HELPERS))
spec = importlib.util.spec_from_file_location('duplicate_worker_guard', HELPERS / 'consolidate_ffmpeg_worker.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class DuplicateGuardTests(unittest.TestCase):
    def test_exact_worker_pid_starttime_and_canonical_or_junction_path_only(self):
        value = dict(PID=123, Started='fixture-start', Name='python.exe',
                     CommandLine=f'python.exe "{helper.ROOT / "pc_ffmpeg_worker.py"}"')
        self.assertTrue(helper.verified(value, 123, 'fixture-start'))
        self.assertTrue(helper.verified({**value, 'CommandLine': f'python.exe "{helper.JUNCTION / "pc_ffmpeg_worker.py"}"'}, 123, 'fixture-start'))
        for bad in (None, {**value, 'PID': 999}, {**value, 'Started': 'reused'},
                    {**value, 'Name': 'ffmpeg.exe'}, {**value, 'CommandLine': 'python.exe nas_repair.py'}):
            self.assertFalse(helper.verified(bad, 123, 'fixture-start'))


if __name__ == '__main__':
    unittest.main()
