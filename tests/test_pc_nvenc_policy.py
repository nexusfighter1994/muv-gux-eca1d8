import importlib.util
from pathlib import Path
import sys
import unittest

CORE = Path(__file__).resolve().parent.parent / 'fflow'
sys.path.insert(0, str(CORE))
spec = importlib.util.spec_from_file_location('nvenc_policy_hook', CORE / 'pc_ffmpeg_hook.py')
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class VfPolicyTests(unittest.TestCase):
    def select(self, output, ready=True, mode='nvenc-high-qp14-v1'):
        method = getattr(hook, 'select_gpu_policy', None)
        self.assertTrue(callable(method), 'explicit VF policy selector is not implemented')
        payload = {'argv': ['-i', '@0.mp4', '-c:v', 'libx264', 'output.mp4'], 'gpuEligible': False}
        method(payload, Path(output), {'nvencReady': ready, 'gpuMode': mode})
        return payload

    def test_only_confirmed_vf_owned_media_gets_new_policy(self):
        for root in ('/data/engines/fflow/tmp/jobs/job_123', '/data/engines/fflow/media'):
            result = self.select(root + '/output.mp4')
            self.assertEqual(result.get('gpuPolicy'), 'nvenc-high-qp14-v1')

    def test_legacy_unknown_unready_and_unrelated_outputs_remain_native(self):
        cases = [('/data/projects/test/chunks/chunk_1.mp4', True, 'nvenc-high-qp14-v1'),
                 ('/data/engines/fflow/tmp/job/output.mp4', False, 'nvenc-high-qp14-v1'),
                 ('/data/engines/fflow/tmp/job/output.mp4', True, 'lossless'),
                 ('/data/engines/fflow/tmp/job/output.png', True, 'nvenc-high-qp14-v1')]
        for path, ready, mode in cases:
            self.assertNotIn('gpuPolicy', self.select(path, ready, mode))

    def test_encoding_only_still_tags_work_for_cpu_when_nvenc_is_unavailable(self):
        payload={'argv':[],'gpuEligible':False}
        hook.select_gpu_policy(payload,Path('/data/engines/fflow/tmp/job/output.mp4'),
                               {'gpuEncodingOnly':True,'nvencReady':False,'gpuMode':'cuda-decode-original-x264'})
        self.assertEqual(payload['gpuPolicy'],'nvenc-high-qp14-v1')


if __name__ == '__main__':
    unittest.main()
