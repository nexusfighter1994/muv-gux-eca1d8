import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import pc_ffmpeg_worker as worker
from test_cuda_scale import native,media
from pc_nvenc_high import nvenc_high_argv
try:
    import pc_cuda_scale as feature
except ModuleNotFoundError:
    feature=None


class CudaScaleWorkerTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(worker,'cuda_scale_candidate'),'worker CUDA integration missing')
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        with patch.object(worker,'run',return_value=subprocess.CompletedProcess([],0,b'',b'')):
            self.state=worker.Worker(sys.executable,'test-token',self.temp.name,probe_gpu=False)
        self.addCleanup(self.state.close)
        self.state.nvenc_ready=True;self.state.nvenc_enabled=True;self.state.gpu_ready=True
        self.state.cuda_scale_ready=True
        self.state.update_config({'enabled':True,'cpuWorkers':2,'gpuWorkers':1})
        (Path(self.temp.name)/'cuda-scale-policy.json').write_text(json.dumps(dict(version=1,enabled=True)))

    def plan(self):
        return feature.cuda_scale_candidate(native(),nvenc_high_argv(native()),Path(self.temp.name),probe=lambda _:media())

    def test_submit_has_own_first_three_reference_checks_and_keeps_original(self):
        self.state.nvenc_started=7
        payload=dict(argv=native(),files={'@0.mp4':base64.b64encode(b'fixture').decode()},
                     timeout=30,gpuPolicy=worker.NVENC_POLICY)
        with patch.object(worker,'normalized_candidate',return_value=nvenc_high_argv(native())), \
             patch.object(worker,'cuda_scale_candidate',return_value=self.plan()), \
             patch.object(worker,'h264_decode_source') as redundant_probe, patch.object(self.state,'render'):
            result=self.state.submit(payload);job=self.state.jobs[result['id']];job['thread'].join(2)
        self.assertIsNotNone(job.get('cuda_scale_plan'))
        self.assertIn('scale_cuda=', ' '.join(job['command']))
        self.assertNotIn('scale_cuda=', ' '.join(job['cpu_command']))
        self.assertTrue(job['verify']);self.assertTrue(job['mixed_verify'])
        redundant_probe.assert_not_called()
        self.state.busy['gpu']=0

    def test_policy_hot_disable_does_not_choose_new_path(self):
        (Path(self.temp.name)/'cuda-scale-policy.json').write_text(json.dumps(dict(version=1,enabled=False)))
        payload=dict(argv=native(),files={'@0.mp4':base64.b64encode(b'fixture').decode()},timeout=30,gpuPolicy=worker.NVENC_POLICY)
        with patch.object(worker,'normalized_candidate',return_value=nvenc_high_argv(native())), \
             patch.object(worker,'cuda_scale_candidate') as choose, \
             patch.object(worker,'h264_decode_source',return_value=False),patch.object(self.state,'render'):
            result=self.state.submit(payload);job=self.state.jobs[result['id']];job['thread'].join(2)
        choose.assert_not_called();self.assertNotIn('cuda_scale_plan',job)
        self.state.busy['gpu']=0

    def test_internal_plan_does_not_allow_external_or_modified_filter_args(self):
        plan=self.plan()
        with self.assertRaises(ValueError):
            self.state.file_command(list(plan.argv),Path(self.temp.name),{'@0.mp4':{}})
        modified=list(plan.argv);modified[modified.index('-vf')+1]='scale_cuda=640:360'
        with self.assertRaises(ValueError):
            self.state.file_command(modified,Path(self.temp.name),{'@0.mp4':{}},cuda_scale_plan=plan)

    def simulate(self,error):
        state=self.state;state.busy['gpu']=1;output=Path(self.temp.name)/'output.mp4'
        job=dict(id='b'*32,output=output,directory=Path(self.temp.name),command=['gpu'],
                 cpu_command=['original-cpu'],lane='gpu',nvenc=True,timeout=30,
                 cancel=threading.Event(),verify=False,cuda_scale_plan=self.plan())
        deadlines=[]
        def execute(job,command):
            deadlines.append(job['deadline'])
            if command==['gpu']:raise RuntimeError(error)
            output.write_bytes(b'original-native-output')
        with patch.object(state,'execute_render',side_effect=execute) as execution, \
             patch.object(state,'run_job',return_value=None),patch.object(state,'request_nvenc_recheck') as recheck:
            state.render(job)
        self.assertEqual(state.busy['gpu'],0)
        return job,deadlines,execution.call_count,recheck.call_count

    def test_bad_scale_output_is_never_published_and_releases_exactly_once(self):
        job,deadlines,calls,_=self.simulate('cuda_scale_output_mismatch')
        self.assertEqual(calls,2);self.assertEqual(deadlines[0],deadlines[1])
        self.assertEqual(job['state'],'done');self.assertTrue(job['gpuRecoveredOnCpu'])
        self.assertEqual(job['output'].read_bytes(),b'original-native-output')
        self.assertTrue(self.state.nvenc_ready);self.assertFalse(self.state.cuda_scale_ready)
        self.assertEqual(self.state.gpu_cpu_recoveries,1)
        self.assertEqual(self.state.cuda_scale_cpu_recoveries,1)
        self.assertEqual(self.state.completed_nvenc,0)
        self.assertEqual(self.state.cuda_scale_completed,0)
        self.assertEqual(self.state.completed['cpu'],1)

    def test_cancellation_and_deadline_never_retry_or_quarantine(self):
        for reason in ['cancelled','timeout','cancelled_or_timeout']:
            with self.subTest(reason=reason):
                job,_,calls,_=self.simulate(reason)
                self.assertEqual(calls,1);self.assertEqual(job['state'],'failed')
                self.assertEqual(self.state.gpu_cpu_recoveries,0)
                self.assertTrue(self.state.cuda_scale_ready)

    def test_unknown_encoder_failure_preserves_original_global_guard(self):
        job,_,calls,rechecks=self.simulate('ffmpeg_failed')
        self.assertEqual(calls,2);self.assertFalse(self.state.nvenc_ready)
        self.assertEqual(rechecks,1);self.assertEqual(job['state'],'done')

    def test_optional_ffprobe_timeout_keeps_prior_path_and_releases_once(self):
        payload=dict(argv=native(),files={'@0.mp4':base64.b64encode(b'fixture').decode()},timeout=30,gpuPolicy=worker.NVENC_POLICY)
        def execute(job,command):job['output'].write_bytes(b'prior-qualified-output')
        with patch.object(worker,'normalized_candidate',return_value=nvenc_high_argv(native())), \
             patch.object(worker,'probe_media',side_effect=subprocess.TimeoutExpired(['ffprobe'],15)), \
             patch.object(worker,'h264_decode_source',return_value=False), \
             patch.object(self.state,'execute_render',side_effect=execute), \
             patch.object(self.state,'run_job',return_value=None), \
             patch.object(worker,'validate_high_output',return_value=media()), \
             patch.object(worker,'verify_pair',return_value=.99):
            result=self.state.submit(payload);job=self.state.jobs[result['id']];job['thread'].join(3)
        self.assertEqual(job['state'],'done');self.assertNotIn('cuda_scale_plan',job)
        self.assertEqual(self.state.busy['gpu'],0)
        self.assertEqual(self.state.completed_nvenc,1)
        self.assertEqual(self.state.cuda_scale_started,0)


if __name__=='__main__':unittest.main()
