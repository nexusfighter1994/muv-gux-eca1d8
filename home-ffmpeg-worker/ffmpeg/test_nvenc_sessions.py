import concurrent.futures
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from pc_nvenc_sessions import NvencSessions
from pc_ffmpeg_worker import Worker


class SessionsTests(unittest.TestCase):
    def job(self, seconds=3):
        return dict(cancel=threading.Event(), deadline=time.monotonic() + seconds)

    def test_fourteen_jobs_keep_eight_encoders_and_all_finish(self):
        gate = NvencSessions(8)
        barrier = threading.Barrier(14)
        lock = threading.Lock()
        active = maximum = 0

        def task(_):
            nonlocal active, maximum
            barrier.wait(timeout=3)
            with gate.session(['ffmpeg', '-c:v', 'h264_nvenc'], self.job()):
                with lock:
                    active += 1
                    maximum = max(maximum, active)
                time.sleep(.1)
                with lock:
                    active -= 1
            return True

        with concurrent.futures.ThreadPoolExecutor(max_workers=14) as pool:
            self.assertEqual(sum(pool.map(task, range(14))), 14)
        self.assertEqual(maximum, 8)
        self.assertEqual(gate.snapshot()['nvencSessionsActive'], 0)
        self.assertEqual(gate.snapshot()['nvencSessionsWaiting'], 0)

    def test_wait_uses_original_deadline(self):
        gate = NvencSessions(1)
        with gate.session(['x', '-c:v', 'h264_nvenc'], self.job()):
            start = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, '^timeout$'):
                with gate.session(['x', '-c:v', 'h264_nvenc'], self.job(.12)):
                    self.fail('expired job admitted')
            self.assertLess(time.monotonic() - start, .5)
        self.assertEqual(gate.snapshot()['nvencSessionsWaiting'], 0)

    def test_cancel_and_cpu_bypass(self):
        gate = NvencSessions(1)
        cancelled = self.job()
        cancelled['cancel'].set()
        with gate.session(['x', '-c:v', 'h264_nvenc'], self.job()):
            with self.assertRaisesRegex(RuntimeError, '^cancelled$'):
                with gate.session(['x', '-c:v', 'h264_nvenc'], cancelled):
                    self.fail('cancelled job admitted')
            with gate.session(['x', '-c:v', 'libx264'], self.job()):
                self.assertEqual(gate.snapshot()['nvencSessionsActive'], 1)

    def test_exception_releases_once(self):
        gate = NvencSessions(1)
        with self.assertRaises(ValueError):
            with gate.session(['x', '-c:v', 'h264_nvenc'], self.job()):
                raise ValueError('spawn failed')
        with gate.session(['x', '-c:v', 'h264_nvenc'], self.job()):
            self.assertEqual(gate.snapshot()['nvencSessionsActive'], 1)
        self.assertEqual(gate.snapshot()['nvencSessionsActive'], 0)

    def test_render_and_probe_share_gate_before_spawn(self):
        worker = Worker.__new__(Worker)
        worker.nvenc_sessions = NvencSessions(1)
        with worker.nvenc_sessions.session(['x', '-c:v', 'h264_nvenc'], self.job()):
            with patch('pc_ffmpeg_worker.subprocess.Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, '^timeout$'):
                    worker.execute_render(self.job(.05), ['x', '-c:v', 'h264_nvenc'])
                with self.assertRaisesRegex(RuntimeError, '^timeout$'):
                    worker.run_job(self.job(), ['x', '-c:v', 'h264_nvenc'], timeout=.05)
                spawn.assert_not_called()
        self.assertEqual(worker.nvenc_sessions.snapshot()['nvencSessionsActive'], 0)

    def test_spawn_failure_releases_worker_permit(self):
        worker = Worker.__new__(Worker)
        worker.nvenc_sessions = NvencSessions(1)
        with tempfile.TemporaryDirectory() as directory:
            job = self.job()
            job.update(directory=Path(directory), output=Path(directory) / 'out.mp4')
            with patch('pc_ffmpeg_worker.subprocess.Popen', side_effect=OSError('spawn')):
                with self.assertRaises(OSError):
                    worker.execute_render(job, ['x', '-c:v', 'h264_nvenc'])
            self.assertEqual(worker.nvenc_sessions.snapshot()['nvencSessionsActive'], 0)

    def test_external_session_contention_retries_only_empty_startup_failure(self):
        worker = Worker.__new__(Worker)
        worker.nvenc_sessions = NvencSessions(1)
        with tempfile.TemporaryDirectory() as directory:
            job = self.job()
            job.update(directory=Path(directory), output=Path(directory) / 'out.mp4')
            calls = []
            def execute(job, command):
                calls.append(list(command))
                if len(calls) == 1:
                    (job['directory'] / 'stderr.log').write_text('OpenEncodeSessionEx failed: incompatible client key (21)\nNothing was written into output file')
                    raise RuntimeError('ffmpeg_failed')
                job['output'].write_bytes(b'x' * 100)
            command = ['x', '-c:v', 'h264_nvenc']
            with patch.object(worker, '_execute_render', side_effect=execute):
                worker.execute_render(job, command)
            self.assertEqual(calls, [command, command])
            self.assertEqual(worker.nvenc_sessions.snapshot()['nvencSessionsActive'], 0)

    def test_old_error_log_never_retries_new_failure(self):
        worker = Worker.__new__(Worker)
        worker.nvenc_sessions = NvencSessions(1)
        with tempfile.TemporaryDirectory() as directory:
            job = self.job()
            job.update(directory=Path(directory), output=Path(directory) / 'out.mp4')
            (job['directory'] / 'stderr.log').write_text('OpenEncodeSessionEx failed: incompatible client key (21)\nNothing was written into output file')
            with patch.object(worker, '_execute_render', side_effect=RuntimeError('ffmpeg_failed')) as run:
                with self.assertRaisesRegex(RuntimeError, '^ffmpeg_failed$'):
                    worker.execute_render(job, ['x', '-c:v', 'h264_nvenc'])
                self.assertEqual(run.call_count, 1)

    def test_contention_retry_is_bounded_and_preserves_partial_output(self):
        worker = Worker.__new__(Worker)
        worker.nvenc_sessions = NvencSessions(1)
        with tempfile.TemporaryDirectory() as directory:
            job = self.job(60)
            job.update(directory=Path(directory), output=Path(directory) / 'out.mp4')
            def failure(job, command):
                with (job['directory'] / 'stderr.log').open('a') as handle:
                    handle.write('OpenEncodeSessionEx failed: incompatible client key (21)\nNothing was written into output file\n')
                raise RuntimeError('ffmpeg_failed')
            with patch.object(worker, '_execute_render', side_effect=failure) as run, \
                 patch.object(job['cancel'], 'wait', return_value=False):
                with self.assertRaisesRegex(RuntimeError, '^nvenc_session_busy$'):
                    worker.execute_render(job, ['x', '-c:v', 'h264_nvenc'])
                self.assertEqual(run.call_count, 12)
                run.reset_mock()
                job['output'].write_bytes(b'partial' * 20)
                with self.assertRaisesRegex(RuntimeError, '^ffmpeg_failed$'):
                    worker.execute_render(job, ['x', '-c:v', 'h264_nvenc'])
                self.assertEqual(run.call_count, 1)
                self.assertEqual(job['output'].read_bytes(), b'partial' * 20)
            self.assertEqual(worker.nvenc_sessions.snapshot()['nvencSessionsActive'], 0)


if __name__ == '__main__':
    unittest.main()
