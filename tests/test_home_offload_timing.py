import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

CORE = Path(__file__).resolve().parents[1] / 'fflow'
sys.path.insert(0, str(CORE))
import pc_ffmpeg_hook as hook


class OffloadTimingTests(unittest.TestCase):
    def test_write_timing_appends_one_json_line_and_rotates(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 't.jsonl'
            hook.write_timing({'a': 1}, file=path)
            hook.write_timing({'b': 2}, file=path)
            self.assertEqual([json.loads(x) for x in path.read_text().splitlines()], [{'a': 1}, {'b': 2}])
            with patch.object(hook, 'TIMING_CAP', 5):
                hook.write_timing({'c': 3}, file=path)
            self.assertEqual(json.loads(path.read_text()), {'c': 3})
            self.assertTrue(Path(str(path) + '.1').is_file())

    def test_write_timing_never_raises(self):
        hook.write_timing({'a': 1}, file='/nonexistent-dir-vf/x/y.jsonl')

    def test_upload_stats_small_and_big(self):
        small = {}
        with patch.object(hook, 'missing_blobs', return_value={'@0.mp4': {'size': 1024}}), \
             patch.object(hook, 'upload_blobs') as upload:
            hook.upload_with_lane('u', 't', {}, {}, small)
        upload.assert_called_once()
        self.assertEqual(small['missing'], 1024)
        self.assertIn('upload', small); self.assertNotIn('big', small)
        big, slot = {}, Mock()
        with patch.object(hook, 'missing_blobs', return_value={'@0.mp4': {'size': 25 * 1024 ** 2}}), \
             patch.object(hook, 'acquire_big_slot', return_value=slot), patch.object(hook, 'upload_blobs'):
            hook.upload_with_lane('u', 't', {}, {}, big)
        self.assertTrue(big['big']); self.assertIn('slotWait', big); self.assertIn('upload', big)
        slot.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
