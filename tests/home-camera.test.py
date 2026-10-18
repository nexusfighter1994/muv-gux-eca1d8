import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'home-graphics-worker' / 'native-camera'
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class CameraContractTests(unittest.TestCase):
    def setUp(self):
        self.worker = load('camera_worker')
        self.payload = dict(source='source.png', target_resolution='1920x1080', fps=24,
            duration_frames=72, camera_path={'track': {'zoom': [1, 1.15]}}, wait_for_results=False)

    def test_accepts_only_plain_original_camera_payload(self):
        self.assertEqual(self.worker.validate_render(self.payload)['duration_frames'], 72)

    def test_treatment_and_extra_effects_remain_native(self):
        for patch in ({'effects': [{'type': 'blur'}]}, {'camera_path': {'treatment': {'id': 'tr_grid_assemble'}, 'track': {'zoom': [1]}}}):
            with self.assertRaises(ValueError): self.worker.validate_render(dict(self.payload, **patch))

    def test_paths_dimensions_clock_and_size_fail_closed(self):
        for patch in ({'source': '../source.png'}, {'fps': 30}, {'duration_frames': 0},
                      {'duration_frames': 1441}, {'target_resolution': '3840x2160'}, {'fps': True}):
            with self.assertRaises(ValueError): self.worker.validate_render(dict(self.payload, **patch))

    def test_encoder_retains_current_high_quality_policy(self):
        args = self.worker.encode_args('out.mp4', 72)
        for key, value in [('-c:v', 'h264_nvenc'), ('-qp', '14'), ('-preset', 'p7'),
                           ('-bf', '0'), ('-profile:v', 'high'), ('-r', '24'), ('-video_track_timescale', '12288')]:
            self.assertEqual(args[args.index(key) + 1], value)

    def test_wrong_native_source_is_not_extracted(self):
        with self.assertRaises(ValueError): load('extract_native').extract('def unrelated(): pass\n')

if __name__ == '__main__': unittest.main()
