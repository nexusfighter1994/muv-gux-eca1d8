import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pc_ffmpeg_worker as worker


class NvencPolicyTests(unittest.TestCase):
    def command(self):
        return ['-y', '-i', '@0.mp4', '-t', '1', '-vf', 'scale=1920:1080',
                '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
                '-r', '24', '-c:a', 'aac', '-b:a', '256k', '-threads', '1',
                '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-flags', '+cgop',
                '-video_track_timescale', '12288', 'output.mp4']

    def builder(self, args):
        function = getattr(worker, 'nvenc_high_argv', None)
        self.assertTrue(callable(function), 'regular High NVENC policy is not implemented')
        return function(args)

    def test_regular_high_is_not_lossless_and_preserves_audio_filters_and_timing(self):
        original = self.command()
        result = self.builder(original)
        self.assertIsNotNone(result)
        self.assertEqual(result[result.index('-c:v') + 1], 'h264_nvenc')
        self.assertEqual(result[result.index('-profile:v') + 1], 'high')
        self.assertEqual(result[result.index('-qp') + 1], '14')
        self.assertNotIn('lossless', result)
        for key in ('-vf', '-t', '-r', '-c:a', '-b:a', '-threads', '-g', '-video_track_timescale'):
            self.assertEqual(result[result.index(key) + 1], original[original.index(key) + 1])
        self.assertEqual(original, self.command(), 'caller args mutated')

    def test_lossless_high444_hdr_and_non_24fps_do_not_use_this_policy(self):
        for key, value in (('-crf', '0'), ('-crf', '12'), ('-pix_fmt', 'yuv444p'), ('-pix_fmt', 'yuv420p10le'), ('-r', '25')):
            args = self.command()
            args[args.index(key) + 1] = value
            self.assertIsNone(self.builder(args))
        for option in (['-profile:v', 'high444'], ['-b:v', '10M'], ['-level:v', '5.2']):
            self.assertIsNone(self.builder(self.command()[:-1] + option + ['output.mp4']))

    def test_unknown_frame_rate_or_pixel_format_is_fail_closed(self):
        for key in ('-r', '-pix_fmt'):
            args = self.command()
            pos = args.index(key)
            del args[pos:pos+2]
            self.assertIsNone(self.builder(args))

    def test_explicit_complex_image_compositions_are_eligible(self):
        args = self.command()
        args[args.index('@0.mp4')] = '@0.png'
        pos = args.index('-vf')
        args[pos:pos+2] = ['-filter_complex', '[0:v]scale=1920:1080,format=yuv420p[v]', '-map', '[v]']
        self.assertIsNotNone(self.builder(args))

    def test_legacy_lossless_helper_stays_unreachable(self):
        source = Path(worker.__file__).read_text()
        self.assertNotIn('gpu_cmd = nvenc_argv', source)
        self.assertNotIn('candidate = nvenc_argv', source)


FFMPEG = r'C:\Users\user\AppData\Local\Programs\compress-video\resources\ffmpeg.exe'


@unittest.skipUnless(Path(FFMPEG).is_file(), 'local FFmpeg required')
class RealNvencTests(unittest.TestCase):
    def test_explicit_policy_encodes_regular_high_and_gpu_failure_recovers_native_cpu(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.mp4'
            worker.run([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1',
                        '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-crf', '18',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(source)])
            state = worker.Worker(FFMPEG, 'test-token', root / 'jobs', probe_gpu=False)
            try:
                state.gpu_ready = True
                state.nvenc_ready = worker.probe_nvenc_high(FFMPEG, state.root, worker.run)
                self.assertTrue(state.nvenc_ready, 'actual NVENC probe and mixed joins must pass')
                state.update_config({'enabled': True, 'cpuWorkers': 2, 'gpuWorkers': 1})
                argv = NvencPolicyTests().command()
                argv[argv.index('scale=1920:1080')] = 'scale=320:180'
                payload = {'argv': argv, 'files': {'@0.mp4': base64.b64encode(source.read_bytes()).decode()},
                           'timeout': 60, 'gpuPolicy': worker.NVENC_POLICY}
                submitted = state.submit(payload)
                job = state.jobs[submitted['id']]
                self.assertIn('h264_nvenc', job['command'])
                job['thread'].join(65)
                self.assertEqual(job['state'], 'done', job.get('error'))
                self.assertEqual(state.health()['completedNvenc'], 1)
                self.assertGreaterEqual(job['qualitySsim'], .98)
                # Explicit legacy payload still uses the existing decode+x264 path.
                legacy = dict(payload)
                legacy.pop('gpuPolicy')
                legacy['gpuEligible'] = True
                result = state.submit(legacy)
                legacy_job = state.jobs[result['id']]
                self.assertNotIn('h264_nvenc', legacy_job['command'])
                legacy_job['thread'].join(65)
                self.assertEqual(legacy_job['state'], 'done', legacy_job.get('error'))
                # One GPU error preserves the original CPU command and disables only NVENC.
                original = state.execute_render
                def fail_gpu_once(job, command):
                    if 'h264_nvenc' in command:
                        raise RuntimeError('ffmpeg_failed')
                    return original(job, command)
                with patch.object(state, 'execute_render', side_effect=fail_gpu_once):
                    result = state.submit(payload)
                    recovered = state.jobs[result['id']]
                    recovered['thread'].join(65)
                self.assertEqual(recovered['state'], 'done', recovered.get('error'))
                self.assertTrue(recovered['gpuRecoveredOnCpu'])
                self.assertFalse(state.nvenc_ready)
                self.assertTrue(state.gpu_ready, 'safe decode should remain available')
                self.assertEqual(state.health()['failed'], 0)
                self.assertEqual(state.health()['gpuCpuRecoveries'], 1)
            finally:
                state.close()

    def test_cancellation_never_retries_or_encodes_on_cpu(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = worker.Worker(FFMPEG, 'test-token', tmp, probe_gpu=False)
            try:
                state.gpu_ready = True
                state.nvenc_ready = True
                state.update_config({'enabled': True, 'cpuWorkers': 1, 'gpuWorkers': 1})
                payload = {'argv': NvencPolicyTests().command(),
                           'files': {'@0.mp4': base64.b64encode(b'source').decode()},
                           'timeout': 20, 'gpuPolicy': worker.NVENC_POLICY}
                with patch.object(state, 'execute_render', side_effect=RuntimeError('cancelled')) as execute:
                    result = state.submit(payload)
                    job = state.jobs[result['id']]
                    job['thread'].join(3)
                self.assertEqual(job['state'], 'failed')
                self.assertEqual(execute.call_count, 1)
                self.assertEqual(state.busy['gpu'], 0)
                self.assertEqual(state.gpu_cpu_recoveries, 0)
            finally:
                state.close()


if __name__ == '__main__':
    unittest.main()
