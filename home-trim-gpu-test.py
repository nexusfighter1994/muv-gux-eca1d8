"""Tests for home-trim-gpu-install.py against a patched Home worker directory (real FFmpeg + NVENC).

Usage: python -I home-trim-gpu-test.py <worker dir>
"""
import base64
from fractions import Fraction
from pathlib import Path
import sys
import tempfile
import unittest

WORKER_DIR = Path(sys.argv.pop(1))
sys.path.insert(0, str(WORKER_DIR))
sys.path.insert(0, str(WORKER_DIR.parent))
import pc_nvenc_high as nh  # noqa: E402
import pc_ffmpeg_worker as worker  # noqa: E402

FFMPEG = r'C:\Users\user\AppData\Local\Programs\compress-video\resources\ffmpeg.exe'
G = ['-loglevel', 'error', '-y', '-nostats', '-progress', 'pipe:1', '-filter_threads', '1', '-filter_complex_threads', '1']


def trim_argv(t):
    # Real server trim shape (Home failure records 2026-11-11).
    return G + ['-ss', '0.5', '-i', '@0.mp4', '-t', t, '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
                '-c:a', 'aac', '-threads', '1', 'output.mp4']


def make_source(path, size):
    worker.run([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i', f'testsrc2=s={size}:r=24:d=4', '-f', 'lavfi', '-i',
                'sine=duration=4:sample_rate=48000', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
                '-video_track_timescale', '12288', '-c:a', 'aac', '-ar', '48000', '-ac', '2', str(path)], timeout=120)


class NumberTests(unittest.TestCase):
    def test_float_noise_snaps_and_bad_values_stay_closed(self):
        self.assertEqual(nh._utility_number('12.2'), Fraction(61, 5))
        self.assertEqual(nh._utility_number('12.200000000000003'), Fraction(61, 5))
        self.assertEqual(nh._utility_number('3.0999999999999996'), Fraction(31, 10))
        self.assertEqual(nh._utility_number('18'), 18)
        self.assertEqual(nh._utility_number('12.2000000051'), Fraction('12.200000005'))
        for bad in ('1e5', '-1', '', None, '12.2.3', ' 12.2', '12.' + '1' * 18):
            self.assertIsNone(nh._utility_number(bad), bad)

    def test_filtered_or_multi_input_commands_are_never_gated(self):
        scaled = trim_argv('3.0')
        scaled[scaled.index('-c:v'):scaled.index('-c:v')] = ['-vf', 'scale=1920:1080']
        self.assertFalse(worker.low_res_simple_trim(scaled, '.'))
        two = trim_argv('3.0')
        two[two.index('-t'):two.index('-t')] = ['-i', '@1.mp4']
        self.assertFalse(worker.low_res_simple_trim(two, '.'))


@unittest.skipUnless(Path(FFMPEG).is_file(), 'local FFmpeg required')
class WorkerTrimTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.hd, cls.low = root / 'hd.mp4', root / 'low.mp4'
        make_source(cls.hd, '1920x1080')
        make_source(cls.low, '256x144')
        cls.state = worker.Worker(FFMPEG, 'test-token', root / 'jobs', probe_gpu=False)
        cls.state.gpu_ready = True
        cls.state.nvenc_ready = worker.probe_nvenc_high(FFMPEG, cls.state.root, worker.run)
        cls.state.update_config({'enabled': True, 'cpuWorkers': 2, 'gpuWorkers': 2})

    @classmethod
    def tearDownClass(cls):
        cls.state.close()
        cls.tmp.cleanup()

    def submit(self, source, t='3.0000000000000004'):
        payload = {'argv': trim_argv(t), 'files': {'@0.mp4': base64.b64encode(source.read_bytes()).decode()},
                   'timeout': 120, 'gpuPolicy': worker.NVENC_POLICY}
        job = self.state.jobs[self.state.submit(payload)['id']]
        job['thread'].join(125)
        self.assertEqual(job['state'], 'done', job.get('error'))
        return job

    def test_nvenc_probe(self):
        self.assertTrue(self.state.nvenc_ready)

    def test_hd_float_noise_trim_runs_on_nvenc_and_validates(self):
        job = self.submit(self.hd)
        self.assertEqual(job['lane'], 'gpu')
        self.assertIn('h264_nvenc', job['command'])
        self.assertIn('3.0000000000000004', job['command'])

    def test_low_res_trim_stays_on_x264_while_cpu_is_free(self):
        job = self.submit(self.low)
        self.assertEqual(job['lane'], 'cpu')
        self.assertNotIn('h264_nvenc', job['command'])

    def test_low_res_trim_overflows_to_nvenc_when_cpu_is_full(self):
        with self.state.lock:
            self.state.busy['cpu'] += self.state.config['cpuWorkers']
        try:
            job = self.submit(self.low)
        finally:
            with self.state.lock:
                self.state.busy['cpu'] -= self.state.config['cpuWorkers']
        self.assertEqual(job['lane'], 'gpu')
        self.assertIn('h264_nvenc', job['command'])

    def test_busy_counters_return_to_zero(self):
        self.submit(self.low)
        self.submit(self.hd)
        self.assertEqual(self.state.busy, {'cpu': 0, 'gpu': 0})


if __name__ == '__main__':
    unittest.main(verbosity=2)
