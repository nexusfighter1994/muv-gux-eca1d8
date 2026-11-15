import base64
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import pc_ffmpeg_worker as worker
from test_nvenc_high import FFMPEG, NvencPolicyTests


class IsolationTests(unittest.TestCase):
    def run_failure(self, reason, utility=True, cancelled=False):
        with tempfile.TemporaryDirectory() as temp:
            state = worker.Worker(FFMPEG, 'test-token', temp, probe_gpu=False, nvenc_enabled=True)
            try:
                state.nvenc_ready = True
                state.gpu_ready = True
                state.busy['gpu'] = 1
                output = Path(temp) / 'output.mp4'
                job = {'id': 'a' * 32, 'output': output, 'directory': Path(temp),
                       'command': ['gpu'], 'cpu_command': ['cpu'], 'lane': 'gpu',
                       'nvenc': True, 'timeout': 30, 'cancel': threading.Event(), 'verify': False}
                if utility:
                    job['utility_contract'] = object()
                if cancelled:
                    job['cancel'].set()
                def execute(job, command):
                    output.write_bytes(b'rejected-gpu' if command == ['gpu'] else b'original-cpu')
                with patch.object(state, 'execute_render', side_effect=execute) as render, \
                     patch.object(state, 'run_job', return_value=None), \
                     patch.object(state, 'request_nvenc_recheck') as recheck, \
                     patch.object(worker, 'validate_utility_trim_output', side_effect=RuntimeError(reason)), \
                     patch.object(worker, 'validate_high_output', side_effect=RuntimeError(reason)):
                    state.render(job)
                    if cancelled:
                        self.assertEqual(render.call_count, 1)
                        self.assertEqual(job['state'], 'failed')
                    else:
                        self.assertEqual(job['state'], 'done')
                        self.assertEqual(output.read_bytes(), b'original-cpu')
                        self.assertEqual(render.call_count, 2)
                        self.assertTrue(job['gpuRecoveredOnCpu'])
                    self.assertEqual(state.busy['gpu'], 0)
                    if reason == 'nvenc_utility_contract_mismatch' and utility and not cancelled:
                        self.assertTrue(state.nvenc_ready, 'one source-specific mismatch must not disable other NVENC policies')
                        self.assertIsNone(state.nvenc_fatal_error)
                        self.assertEqual(state.nvenc_utility_error, reason)
                        self.assertFalse(state.health()['nvencUtilityReady'])
                        self.assertEqual(len(list((Path(temp) / 'gpu-recoveries').glob('*.json'))), 1)
                        recheck.assert_not_called()
                        state.update_config({'enabled': True, 'cpuWorkers': 1, 'gpuWorkers': 1})
                        payload = {'argv': NvencPolicyTests().command(), 'files': {'@0.mp4': base64.b64encode(b'source').decode()},
                                   'timeout': 20, 'gpuPolicy': worker.NVENC_POLICY}
                        # An ineligible regular recipe must not re-enter the quarantined utility policy.
                        with patch.object(worker, 'normalized_candidate', return_value=None), \
                             patch.object(worker, 'utility_trim_candidate') as candidate, \
                             patch.object(worker, 'h264_decode_source', return_value=False), \
                             patch.object(state, 'render'):
                            result = state.submit(payload)
                            state.jobs[result['id']]['thread'].join(2)
                            candidate.assert_not_called()
                    elif reason == 'nvenc_session_busy' and not cancelled:
                        self.assertTrue(state.nvenc_ready)
                        self.assertIsNone(state.nvenc_fatal_error)
                        self.assertIsNone(state.nvenc_utility_error)
                        self.assertEqual(state.gpu_cpu_recoveries, 1)
                        recheck.assert_not_called()
                    elif not cancelled:
                        self.assertFalse(state.nvenc_ready)
                        self.assertEqual(state.nvenc_fatal_error, reason)
            finally:
                state.close()

    def test_utility_mismatch_isolated_and_bad_output_never_delivered(self):
        self.run_failure('nvenc_utility_contract_mismatch')

    def test_unrelated_quality_failure_remains_global_fail_closed(self):
        self.run_failure('nvenc_ssim_mismatch', utility=False)

    def test_unknown_context_never_bypasses_fatal_guard(self):
        self.run_failure('nvenc_utility_contract_mismatch', utility=False)

    def test_cancelled_request_does_not_recover(self):
        self.run_failure('nvenc_utility_contract_mismatch', cancelled=True)

    def test_session_contention_recovers_once_without_disabling_nvenc(self):
        self.run_failure('nvenc_session_busy', utility=False)


if __name__ == '__main__':
    unittest.main()
